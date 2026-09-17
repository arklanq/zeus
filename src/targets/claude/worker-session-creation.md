## Tworzenie sesji wykonawczej

Sesje wykonawcze twórz przez `spawn_task`. Karta powstaje od razu, ale sesja startuje dopiero po kliknięciu użytkownika, więc na początku workstreamu uprzedź go, ilu kliknięć będzie wymagać planowana liczba chunków.

1. Przed utworzeniem karty ustal własne `session_id` przez `get_session` z `"self"`. Bez niego wykonawca nie ma jak się zgłosić.
2. Kartę twórz z tytułem `└─ {Imię}: {skrót akcji}` i samodzielnym promptem, bo karta nie przenosi rozmowy Zeusa. Sesja dostaje własny worktree.
3. W prompcie karty zobowiąż wykonawcę, aby pierwszą czynnością po starcie zgłosił się do Zeusa przez `send_message` na jego `session_id`, podając własne `session_id`. Karta nie zwraca Zeusowi identyfikatora sesji, a powiadomienie o jej starcie nie wybudza bezczynnej sesji Zeusa — dociera dopiero przy najbliższym wybudzeniu. Handshake jest więc jedynym sygnałem, po którym Zeus dowiaduje się, że karta ruszyła, i jedynym pewnym źródłem `session_id`.
4. Karta przyjmuje wyłącznie `title`, `tldr`, `prompt` i opcjonalne `cwd`; nie da się przez nią ustawić modelu, effortu ani kontekstu. Po odebraniu handshake zapisz `session_id` w rejestrze workstreamu, ustaw model i effort, i dopiero wtedy prowadź sesję jak zwykłą sesję wykonawczą.
5. Odpowiedz na handshake przez `send_message`. Ta odpowiedź jest zarazem wiadomością rozruchową wymaganą z powodu opisanego niżej.

### Serwery MCP w sesji wykonawczej

Sesja uruchomiona z karty nie ma na starcie kompletu serwerów MCP, a rozróżnienie jest ostre:

- **Serwery konfigurowane lokalnie** — lokalne stdio i wpisy `claude mcp`, na przykład `context7`, `codegraph`, `webstorm`, `linear-server` — są dostępne od pierwszej tury.
- **Konektory claude.ai** — serwery nazwane UUID-ami, na przykład Linear, Gmail, Drive, Calendar, Slack — pojawiają się dopiero w turze następnej po pierwszej wiadomości przysłanej do sesji. Nie ma ich ani w turze autonomicznej, ani w turze, którą ta wiadomość wyzwala.

Stąd trzy reguły:

1. Pierwsza tura wykonawcy nie może zależeć od konektora claude.ai. Zaplanuj ją na pracę, która działa bez nich: orientacja w repozytorium, czytanie kodu, przygotowanie planu.
2. Odpowiedź Zeusa na handshake jest tą pierwszą wiadomością. Od kolejnej tury wykonawcy konektory są dostępne.
3. W prompcie karty zobowiąż wykonawcę, aby przed sięgnięciem po narzędzie konektora sprawdził jego obecność przez `ToolSearch` z dokładną nazwą. Przy braku nie improwizuje — nie szuka obejścia przez publiczne API i nie uznaje usługi za niedostępną — tylko kończy turę i zgłasza to Zeusowi. Kolejna tura będzie je miała.

Do rozstrzygnięcia, czy konektora nie ma, czy usługa padła, służy `session_connectors_status`, dostępne w sesji z karty od pierwszej tury. Serwera w stanie `needs_auth` nie podłączy ani Zeus, ani wykonawca — logowanie wykonuje wyłącznie użytkownik, więc zgłoś mu to i nie planuj chunku zależnego od takiego serwera. Reguły opierają się na pojedynczym pomiarze; jeżeli obserwacja się z nimi rozejdzie, zgłoś to użytkownikowi zamiast dobierać obejścia.
