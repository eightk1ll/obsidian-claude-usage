'use strict';

const { Plugin, Notice, PluginSettingTab, Setting, requestUrl } = require('obsidian');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

// Safety margin so a token does not expire while a request is in flight.
const EXPIRY_SKEW_MS = 60 * 1000;

// Backoff steps in minutes. An error that does not resolve on its own
// (expired token, 429) must not turn into a constant drumbeat against the API.
const BACKOFF_MINUTES = [15, 30, 60, 120, 240];

const DEFAULT_SETTINGS = {
  credentialsPath: path.join(os.homedir(), '.claude', '.credentials.json'),
  pollMinutes: 15,
  warnThreshold: 75,
  critThreshold: 90,
  showReset: true,
};

/** Reads the OAuth token from the Claude Code credentials file. */
function readCredentials(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error('Cannot read credentials file: ' + filePath);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('Credentials file is not valid JSON');
  }

  const oauth = parsed && parsed.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    throw new Error('No accessToken in credentials file. Run "claude" and execute /login.');
  }

  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes : [];
  if (!scopes.includes('user:profile')) {
    throw new Error('Token is missing the user:profile scope. It was probably created by "claude setup-token" instead of /login.');
  }

  return {
    token: oauth.accessToken,
    expiresAt: oauth.expiresAt || 0,
    scopes,
  };
}

/**
 * Normalises the API response to the windows we display.
 * Deliberately tolerant: missing windows (e.g. weekly_scoped on Pro) are not an error,
 * and the various null fields with internal code names are ignored.
 */
function parseUsage(raw) {
  const windows = [];

  const push = (label, node) => {
    if (!node || typeof node.utilization !== 'number') return;
    windows.push({
      label,
      percent: Math.round(node.utilization),
      resetsAt: node.resets_at ? new Date(node.resets_at) : null,
    });
  };

  push('5 hours', raw.five_hour);
  push('Week', raw.seven_day);

  // Optional model-specific windows, only if actually present.
  const limits = Array.isArray(raw.limits) ? raw.limits : [];
  for (const entry of limits) {
    if (entry && entry.kind === 'weekly_scoped' && typeof entry.percent === 'number') {
      windows.push({
        label: 'Week (top models)',
        percent: Math.round(entry.percent),
        resetsAt: entry.resets_at ? new Date(entry.resets_at) : null,
      });
    }
  }

  return { windows, fetchedAt: new Date() };
}

function formatReset(date) {
  if (!date) return 'unknown';
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return 'in ' + mins + ' min';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return 'in ' + hours + ' h ' + (mins % 60) + ' min';
  return 'in ' + Math.floor(hours / 24) + ' days ' + (hours % 24) + ' h';
}

/** Compact time until reset for the status bar: 47m, 4h52m, 4d7h. */
function formatResetShort(date) {
  if (!date) return null;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'now';

  // Round up, do not truncate: "in 8m" must not show as 7m.
  const totalMin = Math.ceil(diffMs / 60000);
  if (totalMin < 60) return totalMin + 'm';

  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) {
    const mins = totalMin % 60;
    return mins === 0 ? totalHours + 'h' : totalHours + 'h' + String(mins).padStart(2, '0') + 'm';
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? days + 'd' : days + 'd' + hours + 'h';
}

module.exports = class ClaudeUsagePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.usage = null;
    this.error = null;
    // Backoff is persisted. Otherwise every Obsidian restart clears the hold
    // and a permanent error still adds up to hundreds of requests per day,
    // which is exactly the road to a 429.
    const state = this.settings.backoff || {};
    this.blockedUntil = typeof state.blockedUntil === 'number' ? state.blockedUntil : 0;
    this.failures = typeof state.failures === 'number' ? state.failures : 0;

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable');
    this.statusEl.addClass('claude-usage-status');
    this.registerDomEvent(this.statusEl, 'click', () => this.onStatusClick());

    this.addSettingTab(new ClaudeUsageSettingTab(this.app, this));
    this.addCommand({
      id: 'refresh',
      name: 'Refresh usage now',
      callback: () => this.refresh(true),
    });

    this.render();
    this.refresh(false);

    const intervalMs = Math.max(1, this.settings.pollMinutes) * 60 * 1000;
    this.registerInterval(window.setInterval(() => this.refresh(false), intervalMs));

    // Redraw the countdown separately so it does not freeze until the next poll.
    // Purely local, no network traffic.
    this.registerInterval(
      window.setInterval(() => {
        if (this.usage) this.render();
      }, 30 * 1000)
    );
  }

  /**
   * Sets the hold after a failure. Steps grow while nothing succeeds:
   * 15, 30, 60, 120, 240 minutes. A Retry-After from the server extends the
   * hold but never shortens it. Without this staggering, an error that does not
   * resolve on its own turns into a self-inflicted 429 overnight.
   */
  fail(message, retryAfterSec) {
    const step = BACKOFF_MINUTES[Math.min(this.failures, BACKOFF_MINUTES.length - 1)];
    this.failures += 1;

    let waitMs = step * 60 * 1000;
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      waitMs = Math.max(waitMs, retryAfterSec * 1000);
    }
    this.blockedUntil = Date.now() + waitMs;
    this.persistBackoff();

    this.error = message + ' On hold until ' + new Date(this.blockedUntil).toLocaleTimeString() + '.';
    this.render();
  }

  async refresh(manual) {
    // The hold also applies to manual clicks: hammering the button does not help
    // with a 429, it only extends the limit.
    if (Date.now() < this.blockedUntil) {
      if (manual) {
        new Notice(
          (this.error || 'On hold.') + '\nNext attempt from ' + new Date(this.blockedUntil).toLocaleTimeString(),
          8000
        );
      }
      return;
    }

    let creds;
    try {
      creds = readCredentials(this.settings.credentialsPath);
    } catch (err) {
      this.error = err.message;
      this.render();
      return;
    }

    // Deliberately no token refresh of our own. The refresh token rotates; a second
    // writer next to Claude Code only causes conflicts, and a failing refresh on
    // every poll produces exactly the 429 it is supposed to prevent.
    // Expired here means: do not even ask, just show it.
    if (creds.expiresAt && creds.expiresAt < Date.now() + EXPIRY_SKEW_MS) {
      this.error = 'Token expired. Run "claude" and execute /login.';
      this.render();
      return;
    }

    let response;
    try {
      response = await requestUrl({
        url: USAGE_ENDPOINT,
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + creds.token,
          'anthropic-beta': OAUTH_BETA_HEADER,
          'Content-Type': 'application/json',
        },
        throw: false,
      });
    } catch (err) {
      this.fail('Network error: ' + (err && err.message ? err.message : String(err)) + '.');
      return;
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers['retry-after'] || '', 10);
      this.fail('Rate limited (429).', retryAfter);
      return;
    }

    // Token rejected server-side although expiresAt was still in the future.
    // Only /login fixes this, so hold instead of asking again.
    if (response.status === 401) {
      this.fail('Unauthorized (401). Run "claude" and execute /login.');
      return;
    }

    if (response.status === 403) {
      this.fail('Forbidden (403). Token scope is insufficient.');
      return;
    }

    if (response.status !== 200) {
      this.fail('HTTP ' + response.status + '.');
      return;
    }

    try {
      this.usage = parseUsage(response.json);
      this.error = null;
      this.blockedUntil = 0;
      this.failures = 0;
      this.persistBackoff();
    } catch (err) {
      // A 200 we cannot read means the endpoint changed. Retrying every poll
      // will not fix that, so back off like any other persistent error.
      this.fail('Could not parse response: ' + err.message + '.');
      return;
    }
    this.render();
  }

  /** Keeps hold and failure counter in data.json so a restart does not clear them. */
  persistBackoff() {
    const prev = this.settings.backoff || {};
    if (prev.blockedUntil === this.blockedUntil && prev.failures === this.failures) return;
    this.settings.backoff = { blockedUntil: this.blockedUntil, failures: this.failures };
    this.saveSettings();
  }

  levelFor(percent) {
    if (percent >= this.settings.critThreshold) return 'critical';
    if (percent >= this.settings.warnThreshold) return 'warn';
    return 'normal';
  }

  /**
   * Colour is deliberately just an alarm cue with two states.
   * The normal state stays neutral ink, because an ordinal severity scale
   * must not get three hues (green/yellow are indistinguishable with protanopia).
   * Magnitude lives in the arc, the value additionally in the text label.
   */
  colorFor(level) {
    if (level === 'critical') return 'var(--text-error)';
    if (level === 'warn') return 'var(--text-warning)';
    return 'var(--text-muted)';
  }

  /** 14px donut. Arc length = utilisation. */
  ringSvg(percent, color) {
    const NS = 'http://www.w3.org/2000/svg';
    const radius = 5.5;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = (clamped / 100) * circumference;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'claude-usage-ring');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 14 14');

    const mkCircle = () => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', '7');
      c.setAttribute('cy', '7');
      c.setAttribute('r', String(radius));
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke-width', '2');
      return c;
    };

    const track = mkCircle();
    track.setAttribute('stroke', 'var(--background-modifier-border)');
    svg.appendChild(track);

    if (filled > 0) {
      const arc = mkCircle();
      arc.setAttribute('stroke', color);
      arc.setAttribute('stroke-dasharray', filled + ' ' + (circumference - filled));
      // On a full circle a round cap would overlap the start.
      arc.setAttribute('stroke-linecap', filled >= circumference - 0.01 ? 'butt' : 'round');
      arc.setAttribute('transform', 'rotate(-90 7 7)');
      svg.appendChild(arc);
    }

    return svg;
  }

  render() {
    if (!this.statusEl) return;
    this.statusEl.empty();

    if (!this.usage) {
      this.statusEl.createSpan({ cls: 'claude-usage-pending', text: this.error ? 'Claude ?' : 'Claude …' });
      this.statusEl.setAttr('aria-label', this.error || 'Loading usage');
      return;
    }

    for (const w of this.usage.windows) {
      const level = this.levelFor(w.percent);
      const item = this.statusEl.createSpan({ cls: 'claude-usage-item' });

      // Critical gets a glyph so the state does not depend on colour alone.
      if (level === 'critical') {
        const alert = item.createSpan({ cls: 'claude-usage-alert', text: '⚠' });
        alert.setAttr('aria-hidden', 'true');
      }

      item.appendChild(this.ringSvg(w.percent, this.colorFor(level)));

      item.createSpan({
        cls: 'claude-usage-label',
        text: w.percent + '%',
      });

      const reset = this.settings.showReset ? formatResetShort(w.resetsAt) : null;
      if (reset) {
        item.createSpan({ cls: 'claude-usage-reset', text: reset });
      }
    }

    const levelWord = { normal: 'ok', warn: 'high', critical: 'critical' };
    const tooltip = this.usage.windows
      .map(
        (w) =>
          w.label +
          ': ' +
          w.percent +
          '% (' +
          levelWord[this.levelFor(w.percent)] +
          '), reset ' +
          formatReset(w.resetsAt)
      )
      .join('\n');
    const stale = this.error ? '\n\nLast error: ' + this.error : '';
    this.statusEl.setAttr(
      'aria-label',
      tooltip + '\n\nAs of: ' + this.usage.fetchedAt.toLocaleTimeString() + stale
    );
  }

  onStatusClick() {
    if (this.usage) {
      const lines = this.usage.windows.map(
        (w) => w.label + ': ' + w.percent + '% – reset ' + formatReset(w.resetsAt)
      );
      lines.push('As of: ' + this.usage.fetchedAt.toLocaleTimeString());
      if (this.error) lines.push('Error: ' + this.error);
      new Notice(lines.join('\n'), 8000);
    } else if (this.error) {
      new Notice(this.error, 10000);
    }
    this.refresh(true);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class ClaudeUsageSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Credentials file path')
      .setDesc('Read only, never written. Claude Code itself renews the token. The token leaves this device only towards api.anthropic.com.')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.credentialsPath)
          .onChange(async (value) => {
            this.plugin.settings.credentialsPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Poll interval (minutes)')
      .setDesc('The endpoint rate-limits aggressively. Below 15 minutes is not recommended. Takes effect after restarting Obsidian.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pollMinutes))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.pollMinutes = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('Show time until reset')
      .setDesc('Shows next to the percentage when the window resets. Updates every 30 seconds without network access.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showReset).onChange(async (value) => {
          this.plugin.settings.showReset = value;
          await this.plugin.saveSettings();
          this.plugin.render();
        })
      );

    new Setting(containerEl)
      .setName('Warning threshold (%)')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.warnThreshold)).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n)) {
            this.plugin.settings.warnThreshold = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Critical threshold (%)')
      .addText((text) =>
        text.setValue(String(this.plugin.settings.critThreshold)).onChange(async (value) => {
          const n = parseInt(value, 10);
          if (Number.isFinite(n)) {
            this.plugin.settings.critThreshold = n;
            await this.plugin.saveSettings();
          }
        })
      );
  }
}
