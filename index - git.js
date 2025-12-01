// index.js

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    delay 
} = require('@whiskeysockets/baileys');

const readline = require('readline'); 
const fs = require('fs');
const { google } = require('googleapis'); 
const { JWT } = require('google-auth-library'); 
const Database = require('better-sqlite3'); 
const pino = require('pino'); 

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const DB_FILE = 'barbearia.sqlite'; 
const db = new Database(DB_FILE); 

function migrateDB() {
    try {
        const info = db.prepare("PRAGMA table_info(agendamentos)").all();
        const hasFeedbackColumn = info.some(col => col.name === 'nota_feedback');

        if (!hasFeedbackColumn) {
            db.exec('ALTER TABLE agendamentos ADD COLUMN nota_feedback INTEGER');
        }
        
    } catch (e) {
        if (!e.message.includes('no such table')) {
             // console.error("ERRO GRAVE DE SQL na Migração:", e.message); 
        }
    }
}

function initializeDB() {
    const sqlAgendamentos = 'CREATE TABLE IF NOT EXISTS agendamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, barber_name TEXT NOT NULL, data TEXT NOT NULL, hora TEXT NOT NULL, servico TEXT NOT NULL, preco REAL NOT NULL, nome_cliente TEXT NOT NULL, user_id TEXT NOT NULL, data_agendamento TEXT NOT NULL, google_event_id TEXT, nota_feedback INTEGER, UNIQUE(barber_name, data, hora))';
    const sqlScheduledActions = 'CREATE TABLE IF NOT EXISTS scheduled_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, action_type TEXT NOT NULL, scheduled_time TEXT NOT NULL, appointment_id INTEGER, appointment_time TEXT, UNIQUE(appointment_id, action_type))';

    try {
        migrateDB();
        db.exec(sqlAgendamentos);
        db.exec(sqlScheduledActions); 
    } catch (e) {
        // console.error("ERRO GRAVE DE SQL na Inicialização:", e.message); 
        process.exit(1); 
    }
}
initializeDB();

// Estrutura de Barbeiros (Mantenha a estrutura, use dados fictícios para o GitHub)
// O JID do administrador deve vir de uma variável de ambiente ou ser configurável
const BARBERS_INFO = [
    { name: 'Alexandre', calendarId: 'barber1@exemplo.com', jidAdmin: '111111111111@s.whatsapp.net' }, 
    { name: 'Ricardo',   calendarId: 'barber2@exemplo.com',   jidAdmin: '222222222222@s.whatsapp.net' }, 
    { name: 'Murilo',    calendarId: 'barber3@exemplo.com',   jidAdmin: '333333333333@s.whatsapp.net' }, 
];

// Carrega os JIDs de administradores de uma variável de ambiente (separados por vírgula)
const MASTER_ADMINS_JIDS = (process.env.MASTER_ADMINS_JIDS || '').split(',').filter(jid => jid.length > 0)
    .map(jid => jid.trim());

const TIME_ZONE = 'America/Fortaleza'; 

const ALL_SERVICES_LIST = [
    { id: 'social_cut', name: 'Corte Social', price: 30, menu: '1' },
    { id: 'fade_razor', name: 'Degradê Navalhado', price: 35, menu: '2' },
    { id: 'fade_zero', name: 'Degradê no Zero', price: 35, menu: '3' },
    { id: 'social_scissor', name: 'Social só na Tesoura', price: 35, menu: '4' },
    { id: 'machine_cut', name: 'Corte só Máquina', price: 25, menu: '5' },
    { id: 'beard_fade', name: 'Barba com Degradê', price: 25, menu: '6' },
    { id: 'beard_normal', name: 'Barba Normal', price: 20, menu: '7' },
    { id: 'color', name: 'Pintura', price: 20, menu: '8' },
    { id: 'brush', name: 'Escova', price: 15, menu: '9' },
    { id: 'eyebrow', name: 'Sobrancelha', price: 15, menu: '10' },
    { id: 'hairline', name: 'Pezinho', price: 10, menu: '11' },
];

const SERVICES_MAP = new Map(ALL_SERVICES_LIST.map(s => [s.menu, s]));

const EXCLUSIVE_SERVICE_IDS = [
    'social_cut', 'fade_razor', 'fade_zero', 'social_scissor', 'machine_cut' 
];

const TIME_SLOTS = [
    '08:00', '09:00', '10:00', '11:00', '12:00', 
    '13:00', '14:00', '15:00', '16:00', 
    '17:00', '18:00', '19:00'
];

const userStates = new Map();


// --- AUTENTICAÇÃO GOOGLE CALENDAR ---

let googleCredentials;
try {
    googleCredentials = JSON.parse(fs.readFileSync('google-key.json'));
} catch (e) {
    googleCredentials = null; 
}

let calendar = null;
if (googleCredentials) {
    try {
        const authClient = new JWT({
            email: googleCredentials.client_email,
            key: googleCredentials.private_key,
            scopes: ['https://www.googleapis.com/auth/calendar'],
        });
        
        calendar = google.calendar({ version: 'v3', auth: authClient });

    } catch (e) {
        // console.error("❌ ERRO fatal na inicialização do Google Calendar:", e.message);
    }
}


// --- FUNÇÕES DE DATA E HORA ---

function zeroPad(num) {
    return num.toString().padStart(2, '0');
}

function getBrazilDate() {
    const now = new Date();
    const brazilString = now.toLocaleString('en-US', { timeZone: TIME_ZONE });
    return new Date(brazilString);
}

function formatBrazilTime(dateObj) {
    return dateObj.toLocaleString('sv-SE', { 
        timeZone: TIME_ZONE, 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit', 
        hour12: false 
    }).replace(' ', 'T'); 
}

// --- FUNÇÕES DE INTEGRAÇÃO (DB e Calendar) ---

async function getGoogleCalendarBlockedSlots(date, calendarId) { 
    if (!calendar || !calendarId) return [];
    
    try {
        const timeMin = `${date}T00:00:00-03:00`;
        const timeMax = `${date}T23:59:59-03:00`;
        
        const response = await calendar.events.list({
            calendarId: calendarId, 
            timeMin: timeMin,
            timeMax: timeMax,
            timeZone: TIME_ZONE,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const externalEvents = response.data.items || [];
        const blockedSlots = new Set();
        
        for (const event of externalEvents) {
            if (event.start.date) {
                 TIME_SLOTS.forEach(slot => blockedSlots.add(slot));
                 continue;
            }

            const startStr = event.start.dateTime || event.start.date;
            const endStr = event.end.dateTime || event.end.date;

            const start = new Date(startStr);
            const end = new Date(endStr);
            
            for (const slot of TIME_SLOTS) {
                const [slotHour, slotMinute] = slot.split(':').map(Number);
                
                const slotStartString = `${date}T${zeroPad(slotHour)}:${zeroPad(slotMinute)}:00-03:00`;
                const slotStart = new Date(slotStartString);
                const slotEnd = new Date(slotStart.getTime() + 60 * 60000); 
                
                const isOverlapping = slotStart < end && slotEnd > start;
                
                if (isOverlapping) {
                    blockedSlots.add(slot);
                }
            }
        }
        return Array.from(blockedSlots);
    } catch (e) {
        // console.error("ERRO ao buscar eventos do Google Calendar:", e.message);
        return []; 
    }
}


async function getAvailableSlots(date, barberName, barberCalendarId) { 
    const sqlSelect = 'SELECT hora FROM agendamentos WHERE data = ? AND barber_name = ?';
    const localReservedSlots = db.prepare(sqlSelect).all(date, barberName).map(row => row.hora); 

    const googleBlockedSlots = await getGoogleCalendarBlockedSlots(date, barberCalendarId);
    const allReservedSlots = new Set([...localReservedSlots, ...googleBlockedSlots]);

    const nowBrazil = getBrazilDate();
    const todayStr = nowBrazil.toISOString().split('T')[0]; 
    const isToday = date === todayStr;

    const nowHour = nowBrazil.getHours();
    const nowMinute = nowBrazil.getMinutes();

    return TIME_SLOTS.filter(slot => {
        const isReserved = allReservedSlots.has(slot);
        if (isReserved) return false;

        if (isToday) {
            const [slotHour, slotMinute] = slot.split(':').map(Number);
            if (slotHour < nowHour || (slotHour === nowHour && slotMinute <= nowMinute)) {
                return false; 
            }
        }
        return true;
    });
}

async function createGoogleCalendarEvent(date, slot, calendarId, serviceNames, price, clientName, clientUserId) {
    if (!calendar) return null; 
    
    try {
        const startDateTime = `${date}T${slot}:00-03:00`;
        
        const startDateObj = new Date(startDateTime);
        const endDateObj = new Date(startDateObj.getTime() + 60 * 60000); 

        const event = {
            summary: `Corte Agendado: ${clientName}`,
            description: `Serviços: ${serviceNames}\nValor: R$${price.toFixed(2).replace('.', ',')}\nCliente WhatsApp ID: ${clientUserId}`,
            start: { dateTime: startDateTime, timeZone: TIME_ZONE }, 
            end: { dateTime: endDateObj.toISOString(), timeZone: TIME_ZONE },
        };

        const response = await calendar.events.insert({ calendarId: calendarId, resource: event });
        return response.data.id; 
    } catch (e) {
        // console.error("❌ ERRO ao criar evento no Google Calendar:", e.message);
        return null;
    }
}


function reserveSlot(date, slot, reservation, googleEventId, barberName) { 
    const { name, service, price, from, createdAt } = reservation;
    
    try {
        const sqlInsert = 'INSERT INTO agendamentos (data, hora, servico, preco, nome_cliente, user_id, data_agendamento, google_event_id, barber_name, nota_feedback) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        const result = db.prepare(sqlInsert).run(date, slot, service, price, name, from, createdAt, googleEventId, barberName, null);
        return result.lastInsertRowid; 
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT') {
             return null; 
        }
        // console.error("ERRO FATAL ao salvar agendamento no DB:", e.message);
        return null;
    }
}


async function deleteGoogleCalendarEvent(calendarId, eventId) {
    if (!calendar || !calendarId || !eventId) return;
    try {
        await calendar.events.delete({ calendarId: calendarId, eventId: eventId });
    } catch (e) {
        // console.error("ERRO ao deletar evento do Google Calendar:", e.message);
    }
}


async function clearGoogleCalendarDay(date, calendarId) {
    if (!calendar || !calendarId) return 0;
    
    try {
        const timeMin = `${date}T00:00:00-03:00`;
        const timeMax = `${date}T23:59:59-03:00`;
        let deletedCount = 0;

        const response = await calendar.events.list({
            calendarId: calendarId, 
            timeMin: timeMin,
            timeMax: timeMax,
            timeZone: TIME_ZONE,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items || [];
        
        for (const event of events) {
            if (event.summary && event.summary.includes('Agendado')) {
                await calendar.events.delete({ calendarId: calendarId, eventId: event.id });
                deletedCount++;
            }
        }
        return deletedCount;
    } catch (e) {
        // console.error("ERRO ao limpar eventos do Google Calendar:", e.message);
        return -1; 
    }
}

function findAppointmentByUserId(userId) {
    const nowBrazil = getBrazilDate();
    const nowDateTime = formatBrazilTime(nowBrazil).replace('T', ' '); 
    
    const futureSql = `
        SELECT * FROM agendamentos 
        WHERE user_id = ? AND (data || ' ' || hora) >= ?
        ORDER BY data ASC, hora ASC 
        LIMIT 1
    `;
    
    return db.prepare(futureSql).get(userId, nowDateTime);
}


async function deleteAppointment(appointment) { 
    const barberInfo = BARBERS_INFO.find(b => b.name === appointment.barber_name);
    
    if (barberInfo && appointment.google_event_id) {
        await deleteGoogleCalendarEvent(barberInfo.calendarId, appointment.google_event_id);
    }

    const sql = 'DELETE FROM agendamentos WHERE id = ?';
    const result = db.prepare(sql).run(appointment.id);
    return result.changes > 0;
}


// --- FUNÇÕES: ADMINISTRAÇÃO E RELATÓRIOS ---

function getWeeklySchedule(barberName) {
    const nowBrazil = getBrazilDate();
    const nextWeek = new Date(nowBrazil);
    nextWeek.setDate(nowBrazil.getDate() + 7);

    const todayStr = nowBrazil.toISOString().split('T')[0]; 
    const nextWeekStr = nextWeek.toISOString().split('T')[0];

    const sql = `
        SELECT data, hora, nome_cliente, servico 
        FROM agendamentos 
        WHERE barber_name LIKE ? 
        AND data >= ? AND data <= ?
        ORDER BY data ASC, hora ASC
    `;
    
    const rows = db.prepare(sql).all(`%${barberName}%`, todayStr, nextWeekStr);

    if (rows.length === 0) return null;

    let report = `📅 *Agenda Semanal: ${barberName}*\n(De ${todayStr.split('-').reverse().join('/')} a ${nextWeekStr.split('-').reverse().join('/')})\n`;
    let currentDay = '';
    
    rows.forEach(row => {
        const rowDateBr = row.data.split('-').reverse().join('/'); 
        if (rowDateBr !== currentDay) {
            report += `\n🔻 *${rowDateBr}*:`;
            currentDay = rowDateBr;
        }
        report += `\n⏰ ${row.hora} - ${row.nome_cliente} (${row.servico})`;
    });

    return report;
}

function isAdmin(jid) {
    const isBarberAdmin = BARBERS_INFO.some(barber => barber.jidAdmin === jid);
    const isMasterAdmin = MASTER_ADMINS_JIDS.includes(jid);
    return isBarberAdmin || isMasterAdmin;
}


// --- LÓGICA DE AGENDAMENTO (LEMBRETES & FEEDBACK) ---

function scheduleAction(userId, actionType, scheduledTime, appointmentId, appointmentTime) {
    const sql = 'INSERT INTO scheduled_actions (user_id, action_type, scheduled_time, appointment_id, appointment_time) VALUES (?, ?, ?, ?, ?)';
    try {
        db.prepare(sql).run(userId, actionType, scheduledTime, appointmentId, appointmentTime);
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT') {
        } else {
            // console.error(`[SCHEDULER] Erro ao agendar ação:`, e.message);
        }
    }
}

function saveFeedback(appointmentId, score) {
    const sql = 'UPDATE agendamentos SET nota_feedback = ? WHERE id = ?';
    try {
        db.prepare(sql).run(score, appointmentId);
    } catch (e) {
        // console.error(`[DB] Erro ao salvar feedback:`, e.message);
    }
}

async function sendReminder(sock, userId, appointment) {
    const msg = `🔔 *Lembrete:* Seu agendamento de *${appointment.servico}* com *${appointment.barber_name}* é daqui a *30 minutos*, às *${appointment.hora}* na data ${appointment.data.split('-').reverse().join('/')}. Por favor, chegue no horário!`;
    await sendText(sock, userId, msg);
}

async function sendFeedbackRequest(sock, userId, appointment) {
    const msg = `✂️ *Olá, ${appointment.nome_cliente}!* Esperamos que tenha gostado do serviço de *${appointment.servico}* realizado por *${appointment.barber_name}* que terminou há pouco.
\nDe 0 a 10, *o quanto você gostou do serviço?* (Sendo 0 muito ruim e 10 muito bom).
\nPor favor, responda apenas com o número (ex: 9).`;
    await sendText(sock, userId, msg);
    userStates.set(userId, { step: 'collect_feedback', appointmentId: appointment.id });
}

function startScheduler(sock) {
    setInterval(async () => {
        const nowBrazil = getBrazilDate();
        const scheduledTimeNow = formatBrazilTime(nowBrazil); 

        const sqlSelectDue = `SELECT * FROM scheduled_actions WHERE scheduled_time <= ?`;
        const dueActions = db.prepare(sqlSelectDue).all(scheduledTimeNow);

        for (const action of dueActions) {
            const appointment = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(action.appointment_id);

            if (action.action_type === 'reminder' && appointment) {
                await sendReminder(sock, action.user_id, appointment);
            } else if (action.action_type === 'feedback' && appointment) {
                if (appointment.nota_feedback === null) {
                    await sendFeedbackRequest(sock, action.user_id, appointment);
                }
            }
            db.prepare('DELETE FROM scheduled_actions WHERE id = ?').run(action.id);
        }
    }, 60000); 
}


// --- HELPER FUNCTIONS ---

const sendText = async (sock, jid, msg) => {
    await sock.sendMessage(jid, { text: msg });
    await delay(500); 
};

function formatSlotsMessage(slots) {
    if (!slots || !slots.length) return 'Desculpa, não há horários disponíveis nessa data.';
    let msg = '🕒 *Horários disponíveis*:\n'; 
    slots.forEach((s, i) => { msg += `${i + 1} - ${s}\n`; }); 
    msg += '\nResponda com o *número* do horário.';
    return msg;
}

function menuBarberText() {
    let msg = '🧔 *Com qual barbeiro você deseja agendar?*\n------------------------------\n';
    BARBERS_INFO.forEach((barber, i) => { msg += `*${i + 1}.* ${barber.name}\n`; });
    msg += '------------------------------\n\n💡 Digite o *número* ou o *nome do barbeiro*. Digite "cancelar" a qualquer momento.';
    return { text: msg, optionsAvailable: BARBERS_INFO.length };
}

function getServiceData(choice) {
    const ch = (choice || '').toString().trim().toUpperCase();
    const service = SERVICES_MAP.get(ch);
    if (service) {
        return { id: service.id, name: service.name, price: service.price }; 
    }
    if (ch === 'P' || ch === 'PACOTE') {
         return { id: 'pacote', name: 'Pacote Corte Social + Barba Normal', price: 45 };
    }
    return null;
}

function menuServiceText(currentServices = [], isInitialSelection = false) {
    let msg = '✂️ *Escolha o Serviço - Válido a partir de 01/Dez* ✂️\n\n';
    const hasExclusiveService = currentServices.some(s => EXCLUSIVE_SERVICE_IDS.includes(s.id) || s.id === 'pacote');
    
    if (currentServices.length > 0) {
        const total = currentServices.reduce((sum, s) => sum + s.price, 0);
        const names = currentServices.map(s => s.name).join(' + ');
        msg += `✅ *Adicionado:* ${names} | Total: R$${total.toFixed(2).replace('.', ',')}\n`;
        msg += `------------------------------\n`;
    }

    if (!hasExclusiveService && isInitialSelection) {
        msg += '💇‍♂️ *CORTES & ESTILOS*\n';
        msg += '------------------------------\n';
        ALL_SERVICES_LIST.slice(0, 5).forEach(s => { msg += `${s.menu}. ${s.name} | R$${s.price}\n`; });
        msg += '------------------------------\n';
        
        msg += '\n📦 *PACOTES*\n';
        msg += '------------------------------\n';
        msg += '*P.* Pacote Corte Social + Barba Normal | *R$45* (Economize R$5)\n';
        msg += '------------------------------\n';
    }

    msg += '\n✨ *SERVIÇOS ADICIONAIS*\n';
    msg += '------------------------------\n';
    
    ALL_SERVICES_LIST.slice(5, 7).forEach(s => { msg += `${s.menu}. ${s.name} | R$${s.price}\n`; });
    
    ALL_SERVICES_LIST.slice(7).forEach(s => { msg += `${s.menu}. ${s.name} | R$${s.price}\n`; });
    
    msg += '------------------------------\n';

    msg += '\n💡 Digite o *número* ou *P* para Pacote.';

    
    return { text: msg, hasExclusiveService: hasExclusiveService }; 
}


async function isDayAvailable(date, barberName) {
    const barberInfo = BARBERS_INFO.find(b => b.name === barberName);
    if (!barberInfo) return false;
    return (await getAvailableSlots(date, barberName, barberInfo.calendarId)).length > 0;
}

async function getNextAvailableDays(barberName, count = 7) {
    const dates = [];
    const nowBrazil = getBrazilDate();
    
    const options = { timeZone: TIME_ZONE, weekday: 'short', day: '2-digit', month: 'short' };
    const dateFormatter = new Intl.DateTimeFormat('pt-BR', options);
    
    let daysFound = 0;
    let daysChecked = 0;
    while (daysFound < count && daysChecked < 30) {
        const date = new Date(nowBrazil);
        date.setDate(nowBrazil.getDate() + daysChecked);
        const formattedDate = date.toISOString().split('T')[0];

        if (date.getDay() !== 0) { 
            if (await isDayAvailable(formattedDate, barberName)) { 
                dates.push({
                    display: dateFormatter.format(date),
                    value: formattedDate
                });
                daysFound++;
            }
        }
        daysChecked++;
    }
    return dates;
}

async function advanceToDateSelection(sock, from, userId, state) {
    const currentTotal = state.services.reduce((sum, s) => sum + s.price, 0);
    const serviceNames = state.services.map(s => s.name).join(' + ');
    state.currentPrice = currentTotal;
    state.serviceNames = serviceNames;
    state.step = 'choose_date';
    
    const nextDays = await getNextAvailableDays(state.barberName, 7); 
    state.availableDays = nextDays;

    if (nextDays.length === 0) {
        userStates.set(userId, { step: 'idle' }); 
        await sendText(sock, from, `❌ Sem horários disponíveis para *${state.barberName}* nos próximos dias.`);
        return;
    }

    let dateMsg = `📅 *Resumo:* ${state.barberName} | ${serviceNames} | R$${currentTotal.toFixed(2).replace('.', ',')}\n\n*Escolha a data:*\n`;
    nextDays.forEach((day, i) => { dateMsg += `*${i + 1}* - ${day.display}\n`; });
    
    userStates.set(userId, state);
    await sendText(sock, from, dateMsg);
}


// --- PROCESSAMENTO DE MENSAGEM ---

async function processMessage(sock, msg, from) {
    if (!msg.messages || msg.type !== 'notify') return;
    if (from.endsWith('@g.us')) return;

    const message = msg.messages[0];
    const text = (message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();
    const userId = from;
    const contactName = message.pushName || 'Cliente';
    const currentState = userStates.get(userId) || { step: 'idle', services: [], sentIdleInstruction: false, lastAction: 0, barberInfo: null, barberName: null }; 

    if (!text) return;
    
    // --- ADMIN / LIMPEZA DE CALENDÁRIO ---
    if (text.toUpperCase().startsWith('!CLEARGC')) {
        if (!isAdmin(userId)) {
            await sendText(sock, from, '❌ *Acesso Negado.*');
            return;
        }
        
        const parts = text.toUpperCase().split(' ');
        if (parts.length < 3) {
            await sendText(sock, from, '🔒 *Admin:* Uso: !CLEARGC NOME_BARBEIRO YYYY-MM-DD\nEx: *!CLEARGC ALEXANDRE 2025-12-01*');
            return;
        }

        const barberName = parts[1];
        const dateToClear = parts[2];
        const barberInfo = BARBERS_INFO.find(b => b.name.toUpperCase() === barberName);

        if (!barberInfo) {
            await sendText(sock, from, `⚠️ Barbeiro "${barberName}" não encontrado.`);
            return;
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateToClear)) {
            await sendText(sock, from, '⚠️ Formato de data inválido. Use YYYY-MM-DD (Ex: 2025-12-01)');
            return;
        }

        await sendText(sock, from, `⏳ Iniciando limpeza do Google Calendar de *${barberInfo.name}* para a data *${dateToClear}*...`);

        const deleted = await clearGoogleCalendarDay(dateToClear, barberInfo.calendarId);

        if (deleted > 0) {
            await sendText(sock, from, `✅ Limpeza de GC concluída. *${deleted}* eventos de agendamento foram excluídos para ${dateToClear}.`);
        } else if (deleted === 0) {
            await sendText(sock, from, `✅ Limpeza de GC concluída. Nenhum evento de agendamento foi encontrado/excluído para ${dateToClear}.`);
        } else {
            await sendText(sock, from, '❌ Erro na comunicação com o Google Calendar. Verifique os logs.');
        }

        userStates.set(userId, { step: 'idle' });
        return;
    }
    
    // --- ADMIN / AGENDA ---
    if (text.toUpperCase() === '!AGENDA') {
        
        if (isAdmin(userId)) {
            userStates.set(userId, { step: 'admin_waiting_barber_name' });
            await sendText(sock, from, '🔒 *Admin:* Qual barbeiro você quer consultar? (ex: Ricardo)');
            return; 
        }

        userStates.set(userId, { step: 'admin_request_pending' });
        await sendText(sock, from, '❌ *Acesso Negado.*\nDigite **1** para solicitar acesso ao Admin.');
        return;
    }
    
    if (isAdmin(userId) && currentState.step === 'admin_waiting_barber_name') {
        const relatorio = getWeeklySchedule(text);
        if (relatorio) await sendText(sock, from, relatorio);
        else await sendText(sock, from, `⚠️ Nada encontrado para "${text}".`);
        userStates.set(userId, { step: 'idle' });
        return; 
    }
    
    if (currentState.step === 'admin_request_pending') {
        if (text === '1') {
            const notifMsg = `🔔 *REQ ADMIN:* ${contactName}\nJID: \`${userId}\``;
            
            for (const masterJid of MASTER_ADMINS_JIDS) {
                await sendText(sock, masterJid, notifMsg);
            }
            
            await sendText(sock, from, '✅ Solicitação enviada.');
        } else {
            userStates.set(userId, { step: 'idle' });
            await sendText(sock, from, 'Cancelado.');
        }
        return;
    }

    // --- FLUXO CLIENTE ---
    
    const textLower = text.toLowerCase();
    
    if (textLower === 'cancelar' && currentState.step !== 'idle') {
        userStates.set(userId, { step: 'idle' }); 
        await sendText(sock, from, '❌ Cancelado. Digite "agendar" para recomeçar.');
        return;
    }
    
    if (textLower === 'cancelar agendamento') {
        const appointment = findAppointmentByUserId(userId);
        if (!appointment) {
            await sendText(sock, from, '❌ Você não tem agendamentos futuros para cancelar.');
            userStates.set(userId, { step: 'idle' }); 
            return;
        }
        
        currentState.step = 'confirm_cancellation';
        currentState.appointmentToCancel = appointment;
        
        const dateBr = appointment.data.split('-').reverse().join('/');
        const msg = `🚨 *Confirmação de Cancelamento*\n\nVocê deseja cancelar o agendamento de *${appointment.servico}* com *${appointment.barber_name}* para o dia ${dateBr} às ${appointment.hora}?\n\n*1 - Sim, cancelar*\n*2 - Não, manter*`;
        
        userStates.set(userId, currentState);
        await sendText(sock, from, msg);
        return;
    }
    
    if (currentState.step === 'confirm_cancellation') {
        if (text === '1') {
            const appointment = currentState.appointmentToCancel;
            if (await deleteAppointment(appointment)) {
                await sendText(sock, from, '✅ Agendamento cancelado com sucesso.');
            } else {
                await sendText(sock, from, '❌ Erro ao cancelar o agendamento no sistema. Tente novamente ou contate o administrador.');
            }
        } else {
            await sendText(sock, from, '✅ Cancelamento mantido.');
        }
        userStates.set(userId, { step: 'idle' }); 
        return;
    }

    if (textLower === 'agendar' || currentState.step === 'idle') {
        userStates.set(userId, { 
            step: 'choose_barber', 
            services: [], 
            lastAction: Date.now(),
        });
        await sendText(sock, from, menuBarberText().text);
        return;
    }

    // --- 1. Escolha do Barbeiro ---
    if (currentState.step === 'choose_barber') {
        const choice = parseInt(text.trim());
        let barber;
        
        if (!isNaN(choice) && choice > 0 && choice <= BARBERS_INFO.length) {
            barber = BARBERS_INFO[choice - 1];
        } else {
            barber = BARBERS_INFO.find(b => b.name.toLowerCase() === textLower);
        }

        if (barber) {
            currentState.barberInfo = barber;
            currentState.barberName = barber.name;
            currentState.step = 'choose_service';
            
            const serviceMenu = menuServiceText([], true);
            userStates.set(userId, currentState);
            await sendText(sock, from, serviceMenu.text);
            return;
        } else {
            await sendText(sock, from, '⚠️ Opção inválida. Digite o *número* ou o *nome* do barbeiro.');
            return;
        }
    }
    
    // --- 2. Escolha do Serviço ---
    if (currentState.step === 'choose_service') {
        const chosenService = getServiceData(text);
        const currentServices = currentState.services;

        if (chosenService) {
            const isExclusive = EXCLUSIVE_SERVICE_IDS.includes(chosenService.id) || chosenService.id === 'pacote';
            const hasExclusive = currentServices.some(s => EXCLUSIVE_SERVICE_IDS.includes(s.id) || s.id === 'pacote');

            if (hasExclusive && !isExclusive) {
                await sendText(sock, from, '⚠️ Você já selecionou um Corte ou Pacote. Não é possível adicionar mais serviços principais. Digite "CONTINUAR" para escolher a data.');
                return;
            }
            
            if (isExclusive && hasExclusive) {
                await sendText(sock, from, '⚠️ Você só pode escolher um Corte ou Pacote. Digite "CONTINUAR" para escolher a data.');
                return;
            }

            if (!isExclusive && currentServices.some(s => s.id === chosenService.id)) {
                 await sendText(sock, from, `⚠️ O serviço "${chosenService.name}" já foi adicionado. Digite "CONTINUAR" ou escolha outro adicional.`);
                 return;
            }

            if (chosenService.id === 'pacote') {
                currentState.services = [chosenService];
                userStates.set(userId, currentState);
                
                await sendText(sock, from, `✅ ${chosenService.name} adicionado. Digite *CONTINUAR* para escolher a data.`);
                return;
            }
            
            currentState.services.push(chosenService);
            userStates.set(userId, currentState);

            if (EXCLUSIVE_SERVICE_IDS.includes(chosenService.id)) {
                await sendText(sock, from, `✅ ${chosenService.name} adicionado. Você pode adicionar outros serviços *adicionais* ou digitar *CONTINUAR* para escolher a data.`);
            }
            
            const serviceMenu = menuServiceText(currentState.services, false);
            await sendText(sock, from, serviceMenu.text);
            return;

        } else if (text.toUpperCase() === 'CONTINUAR' && currentState.services.length > 0) {
            const isReady = currentState.services.some(s => EXCLUSIVE_SERVICE_IDS.includes(s.id) || s.id === 'pacote');
            
            if (isReady) {
                await advanceToDateSelection(sock, from, userId, currentState);
                return;
            } else {
                await sendText(sock, from, '⚠️ Por favor, escolha pelo menos um *Corte* (1-5) ou o *Pacote* (P) antes de continuar.');
                return;
            }
        } else if (text.toUpperCase() === 'CONTINUAR' && currentState.services.length === 0) {
            await sendText(sock, from, '⚠️ Você precisa escolher pelo menos um serviço.');
            return;
        } else {
            await sendText(sock, from, '⚠️ Opção inválida. Digite o *número* do serviço, *P* para Pacote, ou *CONTINUAR*.');
            return;
        }
    }


    // --- 3. Escolha da Data ---
    if (currentState.step === 'choose_date') {
        const choice = parseInt(text.trim());
        const chosenDay = currentState.availableDays[choice - 1];

        if (chosenDay) {
            currentState.chosenDate = chosenDay.value;
            currentState.step = 'choose_slot';
            
            const availableSlots = await getAvailableSlots(currentState.chosenDate, currentState.barberName, currentState.barberInfo.calendarId);
            
            currentState.availableSlots = availableSlots;
            
            if (availableSlots.length === 0) {
                await sendText(sock, from, `❌ Que pena! Os horários do dia ${chosenDay.display} foram ocupados. Por favor, digite "agendar" para recomeçar.`);
                userStates.set(userId, { step: 'idle' });
                return;
            }
            
            userStates.set(userId, currentState);
            await sendText(sock, from, formatSlotsMessage(availableSlots));
            return;
        } else {
            await sendText(sock, from, '⚠️ Opção inválida. Digite o *número* da data desejada.');
            return;
        }
    }


    // --- 4. Escolha do Horário (Slot) ---
    if (currentState.step === 'choose_slot') {
        const choice = parseInt(text.trim());
        const chosenSlot = currentState.availableSlots[choice - 1];

        if (chosenSlot) {
            currentState.chosenSlot = chosenSlot;
            currentState.step = 'confirm_name';
            
            const dateBr = currentState.chosenDate.split('-').reverse().join('/');
            const msg = `✅ *Confirmação:*\nBarbeiro: ${currentState.barberName}\nData: ${dateBr} às ${chosenSlot}\nServiços: ${currentState.serviceNames}\nValor: R$${currentState.currentPrice.toFixed(2).replace('.', ',')}\n\n*Qual é o seu nome completo para o agendamento?*`;
            
            userStates.set(userId, currentState);
            await sendText(sock, from, msg);
            return;
        } else {
            await sendText(sock, from, '⚠️ Opção inválida. Digite o *número* do horário desejado.');
            return;
        }
    }
    
    
    // --- 5. Confirmação do Nome e Finalização ---
    if (currentState.step === 'confirm_name') {
        const clientName = text.trim();
        if (clientName.length < 3) {
            await sendText(sock, from, '⚠️ Por favor, digite seu nome completo para o agendamento.');
            return;
        }

        const reservation = {
            name: clientName,
            service: currentState.serviceNames,
            price: currentState.currentPrice,
            from: userId,
            createdAt: formatBrazilTime(getBrazilDate()),
        };
        
        let googleEventId = null;

        googleEventId = await createGoogleCalendarEvent(
            currentState.chosenDate,
            currentState.chosenSlot,
            currentState.barberInfo.calendarId,
            currentState.serviceNames,
            currentState.currentPrice,
            clientName,
            userId
        );
        
        if (!googleEventId) {
            await sendText(sock, from, '❌ *ERRO CRÍTICO:* Falha ao conectar ou criar evento no Google Calendar. Seu agendamento não foi concluído. Tente novamente mais tarde.');
            userStates.set(userId, { step: 'idle' });
            return;
        }

        const appointmentId = reserveSlot(
            currentState.chosenDate, 
            currentState.chosenSlot, 
            reservation, 
            googleEventId,
            currentState.barberName
        );

        if (!appointmentId) {
            await deleteGoogleCalendarEvent(currentState.barberInfo.calendarId, googleEventId);
            await sendText(sock, from, '❌ *ERRO FATAL:* Houve um erro ao registrar seu agendamento. O horário pode ter sido reservado por outro cliente. Tente novamente.');
            userStates.set(userId, { step: 'idle' });
            return;
        }

        const appointmentDateTime = `${currentState.chosenDate}T${currentState.chosenSlot}:00-03:00`;
        const appointmentDateObj = new Date(appointmentDateTime);
        
        const reminderTime = new Date(appointmentDateObj.getTime() - 30 * 60000); 
        scheduleAction(userId, 'reminder', formatBrazilTime(reminderTime), appointmentId, appointmentDateTime);
        
        const endTime = new Date(appointmentDateObj.getTime() + 60 * 60000); 
        const feedbackTime = new Date(endTime.getTime() + 60 * 60000); 
        scheduleAction(userId, 'feedback', formatBrazilTime(feedbackTime), appointmentId, appointmentDateTime);

        const dateBr = currentState.chosenDate.split('-').reverse().join('/');
        const finalMsg = `🎉 *Agendamento Confirmado!*\n\n💈 *Barbeiro:* ${currentState.barberName}\n📅 *Data:* ${dateBr}\n⏰ *Hora:* ${currentState.chosenSlot}\n📝 *Serviços:* ${currentState.serviceNames}\n💰 *Total:* R$${currentState.currentPrice.toFixed(2).replace('.', ',')}\n\n*Lembrete:* Te enviaremos uma mensagem 30 minutos antes do horário!`;
        
        userStates.set(userId, { step: 'idle' }); 
        await sendText(sock, from, finalMsg);
        
        const adminMsg = `🔔 *NOVO AGENDAMENTO*\nBarbeiro: ${currentState.barberName}\nCliente: ${clientName}\nData: ${dateBr} às ${currentState.chosenSlot}`;
        await sendText(sock, currentState.barberInfo.jidAdmin, adminMsg);

        return;
    }


    // --- 6. Coleta de Feedback ---
    if (currentState.step === 'collect_feedback' && currentState.appointmentId) {
        const score = parseInt(text.trim());
        
        if (isNaN(score) || score < 0 || score > 10) {
            await sendText(sock, from, '⚠️ Resposta inválida. Por favor, envie apenas um número de 0 a 10.');
            return;
        }

        saveFeedback(currentState.appointmentId, score);
        await sendText(sock, from, '⭐ Obrigado pelo seu feedback! Ele é muito importante para nós.');
        userStates.set(userId, { step: 'idle' }); 
        return;
    }

    // --- Resposta Padrão/Instrução ---
    if (!currentState.sentIdleInstruction) {
        userStates.set(userId, { ...currentState, sentIdleInstruction: true });
        await sendText(sock, from, 'Olá! Digite **AGENDAR** para ver os horários disponíveis, ou **CANCELAR AGENDAMENTO** para gerenciar seu horário.');
    }
}


// --- INICIALIZAÇÃO DO BOT ---

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ['LohanBot', 'Chrome', '4.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            startScheduler(sock);
        }
    });

    sock.ev.on('messages.upsert', (msg) => {
        const from = msg.messages[0].key.remoteJid;
        processMessage(sock, msg, from);
    });
}

connectToWhatsApp();