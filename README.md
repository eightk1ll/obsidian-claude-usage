# Claude Usage

Obsidian-Plugin, das die Auslastung der Claude-Subscription in der Statusleiste anzeigt: 5-Stunden-Fenster, Wochenfenster und, falls vorhanden, das Wochenfenster für Top-Modelle.

Das Plugin liest den OAuth-Token aus der Credentials-Datei von Claude Code und fragt damit den Usage-Endpunkt ab. Es schreibt selbst keinen Token und führt keinen Token-Refresh durch.

## Anzeige

Pro Fenster ein 14px-Ring, der Prozentwert und die Restzeit bis zum Reset (`47m`, `4h52m`, `4d7h`).

- Bis zur Warnschwelle: neutraler Ring
- Ab Warnschwelle (Standard 75 %): Ring in `--text-warning`
- Ab kritischer Schwelle (Standard 90 %): Ring in `--text-error` plus ⚠-Glyph, damit der Zustand nicht an Farbe allein hängt

Tooltip über der Statusleiste zeigt alle Fenster mit Reset-Zeitpunkt und den Stand der letzten Abfrage. Klick auf das Element öffnet dieselben Werte als Notice.

## Voraussetzungen

- Obsidian 1.13.0 oder neuer, nur Desktop
- Claude Code installiert und per `/login` angemeldet. Der Token muss den Scope `user:profile` haben. Ein Token aus `claude setup-token` reicht nicht.
- Credentials-Datei unter `~/.claude/.credentials.json` (Pfad in den Einstellungen änderbar)

## Installation

Manuell:

1. `main.js`, `manifest.json` und `styles.css` nach `<Vault>/.obsidian/plugins/claude-usage/` kopieren
2. Obsidian neu laden und das Plugin unter *Community plugins* aktivieren

Über BRAT: Repository `eightk1ll/obsidian-claude-usage` als Beta-Plugin hinzufügen.

## Einstellungen

| Option | Standard | Bedeutung |
|---|---|---|
| Credentials-Pfad | `~/.claude/.credentials.json` | Datei, aus der der Token gelesen wird |
| Abfrageintervall | 15 Minuten | Abstand zwischen zwei API-Abfragen |
| Warnschwelle | 75 % | Ab hier Ring in Warnfarbe |
| Kritische Schwelle | 90 % | Ab hier Ring in Fehlerfarbe plus Glyph |
| Restzeit anzeigen | an | Countdown bis zum Reset neben dem Prozentwert |

Befehl `Auslastung jetzt aktualisieren` in der Command Palette löst eine manuelle Abfrage aus.

## Fehlerverhalten und Backoff

Fehler, die sich nicht von selbst beheben (abgelaufener Token, 401, 403, 429, Netzwerkfehler), setzen eine Pause. Die Stufen steigen mit jedem weiteren Fehlschlag: 15, 30, 60, 120, 240 Minuten. Ein `Retry-After` vom Server verlängert die Pause, verkürzt sie aber nie. Die Pause gilt auch für den manuellen Klick.

Der Backoff-Zustand wird in `data.json` gespeichert, damit ein Neustart von Obsidian die Sperre nicht zurücksetzt. Ohne diese Staffelung würde ein dauerhafter Fehler über Nacht hunderte Anfragen erzeugen und damit selbst ein 429 auslösen.

Ein abgelaufener Token wird vor der Anfrage erkannt und als Hinweis angezeigt. Lösung ist in allen Fällen: `claude` starten und `/login` ausführen.

## Technik

- Endpunkt: `https://api.anthropic.com/api/oauth/usage` mit Header `anthropic-beta: oauth-2025-04-20`
- Requests laufen über `requestUrl` aus der Obsidian-API
- Kein Build-Schritt: `main.js` ist direkt lauffähig, keine Abhängigkeiten außer der Obsidian-API

## Lizenz

MIT
