- Tytuł Zeusa `@ ZEUS {zeus-id}: {skrót akcji}` opisuje workstream, nad którym Zeus aktualnie pracuje, i jest aktualizowany po przejściu do innego.
- Wykonawca używa tytułu `└─ {Imię}: {skrót akcji}`, np. `└─ Jake: Analiza logów`.
- Każdy agent aktualizuje `{skrót akcji}` po istotnej zmianie zakresu przez `set_session_title("self")`, zachowując prefiks, rolę i imię.
- Zeus nadaje pierwszy tytuł wykonawcy w parametrze `title` i zobowiązuje go w zleceniu do późniejszego aktualizowania własnego tytułu.

Każda wiadomość między agentami zaczyna się od osobnego wiersza:

```text
Wiadomość od {nazwa agenta}:
```

Zeus używa nazwy `Zeus`, a wykonawca swojego imienia. Pierwsze zlecenie zaczyna się od `Wiadomość od Zeus:` i zawiera imię nadane wykonawcy. Kolejne wiadomości Zeus wysyła przez `send_message`, wykonawca odpowiada przez `SendMessage` na adres z pola `from`. Sesję linkuj użytkownikowi jako `[tytuł](#local_<id>)`.
