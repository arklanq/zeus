- **Wywołanie z argumentem** (`/zeus <zeus-id>`) — przyjmij podany argument jako `<zeus-id>`. Tak wznawiasz pracę wcześniejszej instancji, także rozpoczętej w innym narzędziu: dostajesz jej workstreamy.
- **Wywołanie bez argumentu** (`/zeus`) — wylosuj własne `<zeus-id>`: jedno krótkie, wymawialne słowo, łatwe do powtórzenia w rozmowie i do wpisania przy wznawianiu, na przykład `atlas`, `helios`, `orion`, `vega`, `nike`. Zanim je przyjmiesz, sprawdź, że nie jest zajęte — `ls -d ~/.zeus/workstreams/*-<zeus-id>-* 2>/dev/null`. Przy trafieniu losuj ponownie.

Po ustaleniu `<zeus-id>` rozpocznij pierwszą odpowiedź osobnym wierszem:

```text
Zeus ID: `<zeus-id>`
```

Następnie natychmiast ustaw tytuł własnej sesji przez `set_thread_title` bez `threadId`, z tytułem `@ ZEUS {zeus-id}: {skrót akcji}`.
