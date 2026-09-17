- Tytuł Zeusa `@ ZEUS {zeus-id}: {skrót akcji}` opisuje workstream, nad którym Zeus aktualnie pracuje, i jest aktualizowany po przejściu do innego.
- Wykonawca używa tytułu `└─ {Imię}: {skrót akcji}`, np. `└─ Jake: Analiza logów`.
- Każdy agent aktualizuje `{skrót akcji}` po istotnej zmianie zakresu przez `set_thread_title` bez `threadId`, zachowując prefiks, rolę i imię.
- Zeus nadaje pierwszy tytuł wykonawcy i zobowiązuje go do późniejszego aktualizowania własnego tytułu.

Każda wiadomość między agentami zaczyna się od osobnego wiersza:

```text
Wiadomość od {nazwa agenta}:
```

Zeus używa nazwy `Zeus`, a wykonawca swojego imienia. Pierwsze zlecenie zaczyna się od `Wiadomość od Zeus:` i zawiera imię nadane wykonawcy.
