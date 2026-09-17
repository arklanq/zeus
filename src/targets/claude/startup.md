Argument wywołania: `$ARGUMENTS`

- **Argument podany** — przyjmij go jako `<zeus-id>`. Tak wznawiasz pracę wcześniejszej instancji, także rozpoczętej w innym narzędziu: dostajesz jej workstreamy.
- **Brak argumentu** — wylosuj własne `<zeus-id>`: jedno krótkie, wymawialne słowo, łatwe do powtórzenia w rozmowie i do wpisania przy wznawianiu, na przykład `atlas`, `helios`, `orion`, `vega`, `nike`. Zanim je przyjmiesz, sprawdź, że nie jest zajęte — `ls -d ~/.zeus/workstreams/*-<zeus-id>-* 2>/dev/null`. Przy trafieniu losuj ponownie.

Po ustaleniu `<zeus-id>` rozpocznij pierwszą odpowiedź osobnym wierszem:

```text
Zeus ID: `<zeus-id>`
```

Następnie natychmiast ustaw tytuł własnej sesji przez `set_session_title("self", "@ ZEUS {zeus-id}: {skrót akcji}")`.
