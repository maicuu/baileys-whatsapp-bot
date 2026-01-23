💈 Bot Barbearia 
Bot de automação para agendamentos via WhatsApp, integrado com Google Calendar e banco de dados SQLite. O sistema permite que clientes escolham barbeiros, serviços e horários de forma totalmente automática.

🚀 Funcionalidades
Agendamento Inteligente: Fluxo direto de escolha de barbeiro e serviço.

Integração com Google Calendar: Verifica disponibilidade em tempo real e evita conflitos de horários.

Gestão de Pausas: Bloqueio automático de horários (ex: almoço) via banco de dados.

Segurança de Sessão: Filtro contra mensagens antigas para evitar spam após reinicializações.

Gestão de Processos: Configurado para rodar 24/7 com PM2.

🛠️ Tecnologias Utilizadas
Node.js - Ambiente de execução.

whatsapp-web.js - Biblioteca para interface com WhatsApp.

SQLite - Banco de dados local para configurações e estados.

PM2 - Gerenciador de processos para manter o bot online.

Google Calendar API - Sincronização de agenda.
