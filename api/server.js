import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";
import { MercadoPagoConfig, Preference } from "mercadopago";
import fetch from "node-fetch"; 

const app = express();

// --- CONFIGURACIÓN GLOBAL ---
const MASTER_SHEET_ID = "1CYF1IJFEKibbkXTKco-o13ZbMo6KpkT5oJj35Z3q4hg"; 
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwCIzLEl6SP_nGOudLAzJx3KxdSZdHHPwoO8b8KRjBVrb6gEeT8dXuV60yHWT-8TYzh/exec"; 

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- CACHÉ SISTEMA ---
const globalCache = {}; 
const CACHE_DURATION = 20000; 

// --- UTILIDADES ---
const getCleanSlug = (rawSlug) => {
    if (!rawSlug) return "";
    return rawSlug
        .replace("reserva-user-", "")
        .replace("check-availability-", "")
        .replace("/", "")
        .trim();
};

async function getGoogleAuth() {
    return new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
}

async function getSheets() {
    const auth = await getGoogleAuth();
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
}

// --- RUTA RAÍZ ---
app.get("/", (req, res) => {
    res.send("🚀 NegoSocio API Server Is Online (Full Mode)");
});

// --- 0. MERCADO PAGO: CREAR PREFERENCIA DINÁMICA ---
app.post("/api/create-preference", async (req, res) => {
    try {
        const { name, phone, fecha, hora, slug } = req.body;
        const cleanSlug = getCleanSlug(slug);

        const { data: user, error: userError } = await supabase
            .from('usuarios')
            .select('precio, business_name, mp_access_token')
            .eq('slug', cleanSlug)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: "Negocio no encontrado." });
        }

        const precioReal = Number(user.precio) || 0;

        if (precioReal === 0) {
            return res.json({ isFree: true });
        }

        if (!user.mp_access_token) {
            return res.status(400).json({ error: "Este negocio requiere pago pero no configuró Mercado Pago." });
        }

        const clientMP = new MercadoPagoConfig({ accessToken: user.mp_access_token });
        const preference = new Preference(clientMP);

        const response = await preference.create({
            body: {
                items: [{
                    title: `Reserva: ${fecha} - ${hora}hs`,
                    unit_price: precioReal,
                    quantity: 1,
                    currency_id: "ARS"
                }],
                metadata: { nombre: name, telefono: phone, fecha, hora, slug: cleanSlug },
                notification_url: "https://framerturnero.onrender.com/webhook",
                back_urls: { success: "https://negosocio.framer.website/success" },
                auto_return: "approved"
            },
        });

        res.json({ payment_url: response.init_point });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 0.1 MERCADO PAGO: OAUTH CALLBACK ---
app.get("/oauth-callback", async (req, res) => {
    const { code, state: slug } = req.query; 

    if (!code || !slug) {
        return res.status(400).send("No se pudo identificar al usuario o el código es inválido.");
    }

    try {
        const response = await fetch("https://api.mercadopago.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: "3207083483590663",
                client_secret: process.env.MP_CLIENT_SECRET,
                grant_type: "authorization_code",
                code: code,
                redirect_uri: "https://framerturnero.onrender.com/oauth-callback"
            })
        });

        const data = await response.json();

        if (data.access_token) {
            const { error } = await supabase
                .from('usuarios')
                .update({ mp_access_token: data.access_token }) 
                .eq('slug', slug);

            if (error) throw error;

            res.redirect(`https://negosocio.framer.website/dashboard?status=mp_success`);
        } else {
            res.redirect(`https://negosocio.framer.website/dashboard?status=mp_error`);
        }
    } catch (error) {
        res.status(500).send("Error vinculando la cuenta.");
    }
});

// --- WEBHOOK UNIFICADO ---
app.post("/webhook", async (req, res) => {
    const { query, body } = req;
    
    if (query.topic === "payment" || body.type === "payment") {
        const paymentId = query.id || body.data.id;

        try {
            const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
            });
            const paymentData = await paymentResponse.json();

            if (paymentData.status === "approved") {
                const { nombre, telefono, fecha, hora, slug } = paymentData.metadata;
                const partes = fecha.split("-");
                const diaMesFormulario = `${partes[2]}/${partes[1]}`;
                const textoTurnoNuevo = `${diaMesFormulario} - ${hora}`;
                const fechaHoyReal = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

                const sheets = await getSheets();
                await sheets.spreadsheets.values.append({
                    spreadsheetId: MASTER_SHEET_ID,
                    range: "A:E",
                    valueInputOption: "RAW",
                    requestBody: {
                        values: [[nombre.trim(), telefono.toString().trim(), textoTurnoNuevo, fechaHoyReal, slug]]
                    }
                });

                delete globalCache[slug]; 
            }
        } catch (e) {
            console.error("Error en Webhook:", e.message);
        }
    }

    if (body.type === "subscription_preapproval") {
        const subscriptionId = body.data.id;
        try {
            const response = await fetch(`https://api.mercadopago.com/preapproval/${subscriptionId}`, {
                headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
            });
            const subData = await response.json();

            if (subData.status === "authorized") {
                const payerEmail = subData.payer_email;
                await supabase.from('usuarios').update({ plan: 'premium' }).eq('email', payerEmail);
            }
        } catch (e) {
            console.error("Error en Webhook Premium:", e.message);
        }
    }

    res.sendStatus(200);
});

// --- LÓGICA DE REGISTRO ACTUALIZADA ---

app.post("/api/request-verification", async (req, res) => {
    try {
        const { email, usuario, password, plan, precio, duracion_turno, tokens, horarios } = req.body;

        if (!email || !usuario || !password) {
            return res.status(400).json({ error: "Faltan datos obligatorios." });
        }

        console.log("📨 Enviando a Apps Script:", email);

        const googleRes = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" }, 
            body: JSON.stringify({ 
                action: "sendCode", 
                email: email.trim().toLowerCase(),
                usuario,
                password,
                plan: plan || "gratis",
                precio: precio || 0,
                duracion_turno: duracion_turno || 30,
                tokens: tokens || 50,
                horarios: typeof horarios === "string" ? horarios : JSON.stringify(horarios)
            })
        });

        const text = await googleRes.text();
        
        try {
            const result = JSON.parse(text);
            if (result.status === "success") {
                res.json({ success: true });
            } else {
                res.status(500).json({ error: result.message || "Error en Google Script" });
            }
        } catch (parseError) {
            console.error("❌ Error parseando respuesta de Google:", text);
            res.status(500).json({ error: "Respuesta inválida del servidor de correos." });
        }

    } catch (e) {
        console.error("❌ Error en registro:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/verify-and-register", async (req, res) => {
    try {
        const { email, code, business_name, precio, duracion_turno, plan, tokens, horarios } = req.body;

        if (!email || !code) return res.status(400).json({ error: "Faltan datos clave." });

        const googleRes = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ action: "verifyCode", email: email.trim().toLowerCase(), code: code.toString().trim() })
        });
        
        const result = await googleRes.json();

        if (result.status === "valid") {
            const { usuario, password } = result;
            const finalBusinessName = business_name || usuario;
            
            const cleanSlug = finalBusinessName.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

            const { error: insertError } = await supabase.from('usuarios').insert([{ 
                slug: cleanSlug, 
                email: email.trim().toLowerCase(), 
                business_name: finalBusinessName, 
                password: String(password), 
                sheet_id: MASTER_SHEET_ID, 
                precio: parseInt(precio) || 0, 
                duracion_turno: parseInt(duracion_turno) || 30,
                horarios: horarios || {}, 
                plan: plan || 'gratis',
                tokens: parseInt(tokens) || 50,
                mp_access_token: null
            }]);

            if (insertError) return res.status(500).json({ error: "Error Supabase: " + insertError.message });

            res.json({ success: true, slug: cleanSlug });
        } else {
            res.status(400).json({ error: "Código incorrecto." });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- RESTO DE MÉTODOS (ADMIN, LOGIN, STATS) ---

app.get("/verify-session", async (req, res) => {
    try {
        const slug = getCleanSlug(req.query.u);
        const { data: user } = await supabase.from('usuarios').select('slug').eq('slug', slug).single();
        res.json({ active: !!user });
    } catch (e) { res.json({ active: false }); }
});

app.post("/update-settings", async (req, res) => {
    try {
        const { slug, business_name, precio, duracion_turno, h_ini_j, h_fin_j, d_ini, d_fin } = req.body;
        const cleanSlug = getCleanSlug(slug);
        const { error } = await supabase.from('usuarios').update({ 
            business_name, 
            precio: parseInt(precio), 
            duracion_turno: parseInt(duracion_turno),
            hora_inicio_jornada: h_ini_j, 
            hora_fin_jornada: h_fin_j, 
            descanso_inicio: d_ini, 
            descanso_fin: d_fin
        }).eq('slug', cleanSlug);

        if (error) throw error;
        delete globalCache[cleanSlug];
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/get-occupied", async (req, res) => {
    try {
        const slug = getCleanSlug(req.query.slug);
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: "A:E" });
        const rows = response.data.values || [];
        const ocupados = rows.filter(row => row[4] === slug).map(row => row[2]); 
        res.json({ success: true, ocupados });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, fecha, hora, slug: rawSlug } = req.body;
        const slug = getCleanSlug(rawSlug);
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: "A:E" });
        const rows = response.data.values || [];

        if (rows.some(row => row[1] === phone.toString().trim() && row[4] === slug)) {
            return res.status(400).json({ success: false, error: "Ya tenés un turno agendado." });
        }

        const partes = fecha.split("-");
        const diaMesFormulario = `${partes[2]}/${partes[1]}`;
        const textoTurnoNuevo = `${diaMesFormulario} - ${hora}`;
        const fechaHoyReal = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        await sheets.spreadsheets.values.append({
            spreadsheetId: MASTER_SHEET_ID, range: "A:E", valueInputOption: "RAW",
            requestBody: { values: [[name.trim(), phone.toString().trim(), textoTurnoNuevo, fechaHoyReal, slug]] }
        });

        delete globalCache[slug];
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/login", async (req, res) => {
    try {
        const slug = getCleanSlug(req.body.slug);
        const { password } = req.body;
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (user && String(user.password) === String(password)) return res.json({ success: true, slug: user.slug });
        res.status(401).json({ success: false, error: "Credenciales inválidas" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin-stats/:slug", async (req, res) => {
    const slug = getCleanSlug(req.params.slug);
    const now = Date.now();
    if (globalCache[slug] && (now - globalCache[slug].timestamp < CACHE_DURATION)) return res.json(globalCache[slug].data);

    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: "A:E" });
        const allRows = response.data.values || [];
        const rows = allRows.filter((r, i) => i === 0 || r[4] === slug);

        const ahoraArg = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
        const mesActual = ahoraArg.getMonth() + 1;
        const diaHoyNum = ahoraArg.getDate();
        const añoActual = ahoraArg.getFullYear();

        let turnosHoy = 0, turnosMesActual = 0, turnosLista = [];
        let semanas = { "Sem 1": 0, "Sem 2": 0, "Sem 3": 0, "Sem 4": 0 };

        rows.forEach((r, i) => {
            if (i === 0 || !r[2]) return;
            const partes = r[2].toString().trim().split(" - ");
            if (partes.length < 2) return;
            const [dia, mes] = partes[0].split("/").map(Number);

            if (mes === mesActual) {
                turnosMesActual++;
                if (dia === diaHoyNum) turnosHoy++;
                if (dia <= 7) semanas["Sem 1"]++;
                else if (dia <= 14) semanas["Sem 2"]++;
                else if (dia <= 21) semanas["Sem 3"]++;
                else semanas["Sem 4"]++;
            }
            turnosLista.push({ 
                nombre: r[0], 
                telefono: r[1], 
                fecha: `${añoActual}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`, 
                hora: partes[1], 
                rawTurno: r[2] 
            });
        });

        const finalData = {
            stats: {
                turnosHoy, turnosMes: turnosMesActual,
                ingresosEstimados: turnosMesActual * (user.precio || 0),
                promedioDiario: diaHoyNum > 0 ? Math.round((turnosMesActual * (user.precio || 0)) / diaHoyNum) : 0,
                chartData: Object.keys(semanas).map(key => ({ label: key, turnos: semanas[key] })),
                businessName: user.business_name || user.slug,
                config: { duracion: user.duracion_turno, h_ini_j: user.hora_inicio_jornada, h_fin_j: user.hora_fin_jornada, d_ini: user.descanso_inicio, d_fin: user.descanso_fin, precio: user.precio, mp_status: user.mp_access_token ? "Conectado" : "Desconectado", plan: user.plan || 'gratis' },
                turnosLista: turnosLista.reverse()
            }
        };

        globalCache[slug] = { timestamp: now, data: finalData };
        res.json(finalData);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/cancel-appointment", async (req, res) => {
    try {
        const { slug, rawTurno } = req.body;
        const cleanSlug = getCleanSlug(slug);
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: "A:E" });
        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(r => r[2] === rawTurno && r[4] === cleanSlug);

        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID });
        const sheetIdReal = spreadsheet.data.sheets[0].properties.sheetId;

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: MASTER_SHEET_ID,
            requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheetIdReal, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 } } }] }
        });
        delete globalCache[cleanSlug];
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor NegoSocio corriendo en puerto ${PORT}`));
