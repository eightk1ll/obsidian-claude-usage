'use strict';

const { Plugin, Notice, PluginSettingTab, Setting, requestUrl } = require('obsidian');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

// Vorlauf, damit ein Token nicht waehrend der laufenden Anfrage ablaeuft.
const EXPIRY_SKEW_MS = 60 * 1000;

// Backoff-Stufen in Minuten. Ein Fehler, der sich nicht von selbst behebt
// (abgelaufener Token, 429), darf keinen Dauertakt gegen die API erzeugen.
const BACKOFF_MINUTES = [15, 30, 60, 120, 240];

const DEFAULT_SETTINGS = {
  credentialsPath: path.join(os.homedir(), '.claude', '.credentials.json'),
  pollMinutes: 15,
  warnThreshold: 75,
  critThreshold: 90,
  showReset: true,
};

/** Liest den OAuth-Token aus der Claude-Code-Credentials-Datei. */
function readCredentials(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error('Credentials-Datei nicht lesbar: ' + filePath);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('Credentials-Datei ist kein gueltiges JSON');
  }

  const oauth = parsed && parsed.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    throw new Error('Kein accessToken in der Credentials-Datei. Einmal "claude" starten und /login ausfuehren.');
  }

  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes : [];
  if (!scopes.includes('user:profile')) {
    throw new Error('Token fehlt der Scope user:profile. Token stammt vermutlich aus "claude setup-token" statt aus /login.');
  }

  return {
    token: oauth.accessToken,
    expiresAt: oauth.expiresAt || 0,
    refreshToken: oauth.refreshToken || null,
    refreshTokenExpiresAt: oauth.refreshTokenExpiresAt || 0,
    scopes,
  };
}

/**
 * Normalisiert die API-Antwort auf die Fenster, die wir anzeigen.
 * Bewusst tolerant: fehlende Fenster (z.B. weekly_scoped auf Pro) sind kein Fehler,
 * und die diversen null-Felder mit internen Codenamen werden ignoriert.
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

  push('5 Stunden', raw.five_hour);
  push('Woche', raw.seven_day);

  // Optionale, modellspezifische Fenster nur wenn wirklich vorhanden.
  const limits = Array.isArray(raw.limits) ? raw.limits : [];
  for (const entry of limits) {
    if (entry && entry.kind === 'weekly_scoped' && typeof entry.percent === 'number') {
      windows.push({
        label: 'Woche (Top-Modelle)',
        percent: Math.round(entry.percent),
        resetsAt: entry.resets_at ? new Date(entry.resets_at) : null,
      });
    }
  }

  return { windows, fetchedAt: new Date() };
}

function formatReset(date) {
  if (!date) return 'unbekannt';
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'jetzt';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return 'in ' + mins + ' Min';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return 'in ' + hours + ' h ' + (mins % 60) + ' Min';
  return 'in ' + Math.floor(hours / 24) + ' Tagen ' + (hours % 24) + ' h';
}

/** Kompakte Restzeit fuer die Statusleiste: 47m, 4h52m, 4d7h. */
function formatResetShort(date) {
  if (!date) return null;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'jetzt';

  // Aufrunden, nicht abschneiden: "in 8m" soll nicht als 7m erscheinen.
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
    // Backoff wird persistiert. Sonst setzt jeder Obsidian-Neustart die Sperre
    // zurueck und ein dauerhafter Fehler kommt ueber den Tag doch auf hunderte
    // Requests - genau der Weg ins 429.
    const state = this.settings.backoff || {};
    this.blockedUntil = typeof state.blockedUntil === 'number' ? state.blockedUntil : 0;
    this.failures = typeof state.failures === 'number' ? state.failures : 0;

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable');
    this.statusEl.style.cursor = 'pointer';
    this.statusEl.onclick = () => this.onStatusClick();

    this.addSettingTab(new ClaudeUsageSettingTab(this.app, this));
    this.addCommand({
      id: 'claude-usage-refresh',
      name: 'Auslastung jetzt aktualisieren',
      callback: () => this.refresh(true),
    });

    this.render();
    this.refresh(false);

    const intervalMs = Math.max(1, this.settings.pollMinutes) * 60 * 1000;
    this.registerInterval(window.setInterval(() => this.refresh(false), intervalMs));

    // Countdown separat neu zeichnen, damit er nicht bis zum naechsten Poll einfriert.
    // Rein lokal, kein Netzwerkverkehr.
    this.registerInterval(
      window.setInterval(() => {
        if (this.usage) this.render();
      }, 30 * 1000)
    );
  }

  /**
   * Setzt die Pause nach einem Fehlschlag. Die Stufen steigen, solange nichts
   * gelingt: 15, 30, 60, 120, 240 Minuten. Ein Retry-After vom Server verlaengert
   * zusaetzlich, verkuerzt aber nie. Ohne diese Staffelung wird aus einem Fehler,
   * der sich nicht von selbst behebt, ueber Nacht ein selbstverschuldetes 429.
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

    this.error = message + ' Pause bis ' + new Date(this.blockedUntil).toLocaleTimeString() + '.';
    this.render();
  }

  async refresh(manual) {
    // Sperre gilt auch fuer den manuellen Klick: bei 429 hilft Draufdruecken nicht,
    // es verlaengert nur das Limit.
    if (Date.now() < this.blockedUntil) {
      if (manual) {
        new Notice(
          (this.error || 'Pause') + '\nNaechster Versuch ab ' + new Date(this.blockedUntil).toLocaleTimeString(),
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

    // Bewusst kein eigener Token-Refresh. Der Refresh Token rotiert; ein zweiter
    // Schreiber neben Claude Code bringt nur Konflikte, und ein fehlschlagender
    // Refresh im Poll-Takt erzeugt genau das 429, das er verhindern soll.
    // Abgelaufen heisst hier: gar nicht erst anfragen, sondern anzeigen.
    if (creds.expiresAt && creds.expiresAt < Date.now() + EXPIRY_SKEW_MS) {
      this.error = 'Token abgelaufen. Einmal "claude" starten und /login ausfuehren.';
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
      this.fail('Netzwerkfehler: ' + (err && err.message ? err.message : String(err)) + '.');
      return;
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers['retry-after'] || '', 10);
      this.fail('Rate limited (429).', retryAfter);
      return;
    }

    // Token serverseitig verworfen, obwohl expiresAt noch in der Zukunft lag.
    // Das loest nur /login, also pausieren statt weiter anzufragen.
    if (response.status === 401) {
      this.fail('Nicht autorisiert (401). Einmal "claude" starten und /login ausfuehren.');
      return;
    }

    if (response.status === 403) {
      this.fail('Kein Zugriff (403). Token-Scope reicht nicht.');
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
      this.error = 'Antwort nicht verstanden: ' + err.message;
    }
    this.render();
  }

  /** Haelt Sperre und Fehlerzaehler in data.json, damit ein Neustart sie nicht loescht. */
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
   * Farbe ist bewusst nur ein Alarm-Cue mit zwei Zustaenden.
   * Der Normalzustand bleibt neutrale Ink, weil eine ordinale Severity-Skala
   * keine drei Hues bekommen darf (Gruen/Gelb sind bei Protanopie ununterscheidbar).
   * Die Groesse steckt im Bogen, der Wert zusaetzlich im Text-Label.
   */
  colorFor(level) {
    if (level === 'critical') return 'var(--text-error)';
    if (level === 'warn') return 'var(--text-warning)';
    return 'var(--text-muted)';
  }

  /** 14px-Donut. Bogenlaenge = Auslastung. */
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
      // Bei Vollkreis wuerde ein runder Cap ueber den Anfang lappen.
      arc.setAttribute('stroke-linecap', filled >= circumference - 0.01 ? 'butt' : 'round');
      arc.setAttribute('transform', 'rotate(-90 7 7)');
      svg.appendChild(arc);
    }

    return svg;
  }

  render() {
    if (!this.statusEl) return;
    this.statusEl.empty();
    this.statusEl.style.color = '';

    if (!this.usage) {
      const el = this.statusEl.createSpan({ text: this.error ? 'Claude ?' : 'Claude …' });
      el.style.color = 'var(--text-muted)';
      this.statusEl.setAttr('aria-label', this.error || 'Lade Auslastung');
      return;
    }

    for (const w of this.usage.windows) {
      const level = this.levelFor(w.percent);
      const item = this.statusEl.createSpan({ cls: 'claude-usage-item' });

      // Kritisch bekommt ein Glyph, damit der Zustand nicht an Farbe allein haengt.
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

    const levelWord = { normal: 'ok', warn: 'hoch', critical: 'kritisch' };
    const tooltip = this.usage.windows
      .map(
        (w) =>
          w.label +
          ': ' +
          w.percent +
          '% (' +
          levelWord[this.levelFor(w.percent)] +
          '), Reset ' +
          formatReset(w.resetsAt)
      )
      .join('\n');
    const stale = this.error ? '\n\nLetzter Fehler: ' + this.error : '';
    this.statusEl.setAttr(
      'aria-label',
      tooltip + '\n\nStand: ' + this.usage.fetchedAt.toLocaleTimeString() + stale
    );
  }

  onStatusClick() {
    if (this.usage) {
      const lines = this.usage.windows.map(
        (w) => w.label + ': ' + w.percent + '% – Reset ' + formatReset(w.resetsAt)
      );
      lines.push('Stand: ' + this.usage.fetchedAt.toLocaleTimeString());
      if (this.error) lines.push('Fehler: ' + this.error);
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
      .setName('Pfad zur Credentials-Datei')
      .setDesc('Wird nur gelesen, nie geschrieben. Erneuert wird der Token von Claude Code selbst. Der Token verlaesst das Geraet nur Richtung api.anthropic.com.')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.credentialsPath)
          .onChange(async (value) => {
            this.plugin.settings.credentialsPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Abfrageintervall (Minuten)')
      .setDesc('Der Endpoint drosselt hart. Unter 15 Minuten nicht empfohlen. Aenderung wirkt nach Obsidian-Neustart.')
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
      .setName('Restzeit bis Reset anzeigen')
      .setDesc('Zeigt hinter dem Prozentwert, wann sich das Fenster zurueckstellt. Aktualisiert sich alle 30 Sekunden ohne Netzwerkzugriff.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showReset).onChange(async (value) => {
          this.plugin.settings.showReset = value;
          await this.plugin.saveSettings();
          this.plugin.render();
        })
      );

    new Setting(containerEl)
      .setName('Warnschwelle (%)')
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
      .setName('Kritisch-Schwelle (%)')
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
