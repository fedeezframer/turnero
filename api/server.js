import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";
import { MercadoPagoConfig, Preference } from "mercadopago";
import fetch from "node-fetch"; // Asegurate de tener node-fetch instalado o usa el fetch nativo de Node 18+

const app = express();

// --- CONFIGURACIÓN GLOBAL ---
const MASTER_SHEET_ID = "1CYF1IJFEKibbkXTKco-o13ZbMo6KpkT5oJj35Z3q4hg"; 

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- CACHÉ SISTEMA ---
const globalCache = {}; 
const CACHE_DURATION = 20000; // 20 segundos

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

// --- 0. MERCADO PAGO: CREAR PREFERENCIA DINÁMICA ---
app.post("/api/create-preference", async (req, res) => {
    try {
        const { name, phone, fecha, hora, slug } = req.body;
        const cleanSlug = getCleanSlug(slug);

        const { data: user, error: userError } = await supabase
            .from('usuarios')
            .withConverter(null)
            .select('precio, business_name, mp_access_token')
            .eq('slug', cleanSlug)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: "No se encontró el negocio para procesar el pago." });
        }

        if (!user.mp_access_token) {
            return res.status(400).json({ error: "El negocio no tiene configurado Mercado Pago." });
        }

        const clientMP = new MercadoPagoConfig({ 
            accessToken: user.mp_access_token 
        });

        const preference = new Preference(clientMP);

        const precioReal = Number(user.precio) || 5000;
        const nombreNegocio = user.business_name || cleanSlug;

        const response = await preference.create({
            body: {
                items: [
                    {
                        title: `Reserva en ${nombreNegocio}: ${fecha} - ${hora}hs`,
                        unit_price: precioReal,
                        quantity: 1,
                        currency_id: "ARS"
                    }
                ],
                metadata: {
                    nombre: name,
                    telefono: phone,
                    fecha: fecha,
                    hora: hora,
                    slug: cleanSlug,
                    precio: precioReal,
                    vendedor_token: user.mp_access_token // Guardamos el token para el webhook
                },
                back_urls: {
                    success: "https://dreamwebtesttemplate.framer.website/success",
                    failure: "https://dreamwebtesttemplate.framer.website/error",
                    pending: "https://dreamwebtesttemplate.framer.website/error"
                },
                auto_return: "approved",
                notification_url: "https://framerturnero.onrender.com/webhook"
            },
        });

        res.json({ payment_url: response.init_point });
    } catch (error) {
        console.error("Error al crear preferencia:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- NUEVO: OAUTH CALLBACK (VINCULACIÓN ESTILO TIENDANUBE) ---
app.get("/oauth-callback", async (req, res) => {
    const { code, slug } = req.query;

    if (!code || !slug) {
        return res.status(400).send("Código de autorización o slug faltante.");
    }

    try {
        const response = await fetch("https://api.mercadopago.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: process.env.MP_CLIENT_ID,
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

            // Redirigir al dashboard de Framer con éxito
            res.redirect(`https://dreamwebtesttemplate.framer.website/dashboard?status=mp_success`);
        } else {
            console.error("Error en intercambio de token:", data);
            res.redirect(`https://dreamwebtesttemplate.framer.website/dashboard?status=mp_error`);
        }
    } catch (error) {
        console.error("Error OAuth:", error);
        res.status(500).send("Error vinculando cuenta.");
    }
});

// --- WEBHOOK: ACTUALIZADO PARA MP DINÁMICO ---
app.post("/webhook", async (req, res) => {
    const { query } = req;
    const topic = query.topic || req.body.type;

    if (topic === "payment") {
        const paymentId = query.id || req.body.data.id;

        try {
            // Buscamos el pago usando el token maestro para obtener la metadata inicial
            // (Si MP no permite ver metadata sin el token del vendedor, aquí usamos el fallback del .env)
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

                console.log(`✅ Pago aprobado y agendado: ${nombre} (${slug})`);
                delete globalCache[slug]; 
            }
        } catch (e) {
            console.error("❌ Error en Webhook:", e.message);
        }
    }
    res.sendStatus(200);
});

// 1. REGISTRO (Simplificado para el Dashboard)
app.post("/register", async (req, res) => {
    try {
        const { usuario, email, password } = req.body;
        if (!usuario || !password || !email) return res.status(400).json({ error: "Faltan datos." });

        const cleanSlug = usuario.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

        const { error: supabaseError } = await supabase.from('usuarios').insert([{ 
            slug: cleanSlug, 
            email,
            business_name: cleanSlug, 
            password: String(password), 
            sheet_id: MASTER_SHEET_ID,
            precio: 10000,
            mp_access_token: null, // Se vincula después vía OAuth
            duracion_turno: 30,
            hora_inicio_jornada: '09:00',
            hora_fin_jornada: '20:00',
            descanso_inicio: '13:00',
            descanso_fin: '15:00'
        }]);

        if (supabaseError) throw supabaseError;
        res.json({ success: true, slug: cleanSlug });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. VERIFICAR SESIÓN
app.get("/verify-session", async (req, res) => {
    try {
        const slug = getCleanSlug(req.query.u);
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('slug')
            .eq('slug', slug)
            .single();

        if (error || !user) {
            return res.json({ active: false });
        }
        res.json({ active: true });
    } catch (e) {
        res.json({ active: false });
    }
});

// 3. ACTUALIZAR CONFIGURACIÓN
app.post("/update-settings", async (req, res) => {
    try {
        const { 
            slug, business_name, precio,
            duracion_turno, h_ini_j, h_fin_j, d_ini, d_fin 
        } = req.body;
        
        const cleanSlug = getCleanSlug(slug);

        const { error } = await supabase
            .from('usuarios')
            .update({ 
                business_name: business_name, 
                precio: parseInt(precio),
                duracion_turno: parseInt(duracion_turno),
                hora_inicio_jornada: h_ini_j,
                hora_fin_jornada: h_fin_j,
                descanso_inicio: d_ini,
                descanso_fin: d_fin
            })
            .eq('slug', cleanSlug);

        if (error) throw error;

        delete globalCache[cleanSlug];
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. OBTENER OCUPADOS
app.get("/get-occupied", async (req, res) => {
    try {
        const slug = getCleanSlug(req.query.slug);
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: "A:E", 
        });

        const rows = response.data.values || [];
        const ocupados = rows
            .filter(row => row[4] === slug) 
            .map(row => row[2]); 

        res.json({ success: true, ocupados });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. CREAR RESERVA (Directa sin pago)
app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, fecha, hora, slug: rawSlug } = req.body;
        const slug = getCleanSlug(rawSlug);

        if (!fecha || !hora || !phone) {
            return res.status(400).json({ error: "Datos incompletos" });
        }

        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: "A:E",
        });

        const rows = response.data.values || [];
        const yaTieneTurno = rows.some(row => 
            row[1] === phone.toString().trim() && 
            row[4] === slug
        );

        if (yaTieneTurno) {
            return res.status(400).json({ 
                success: false, 
                error: "Ya tenés un turno agendado con este negocio." 
            });
        }

        const partes = fecha.split("-");
        const diaMesFormulario = `${partes[2]}/${partes[1]}`;
        const textoTurnoNuevo = `${diaMesFormulario} - ${hora}`;
        const fechaHoyReal = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        await sheets.spreadsheets.values.append({
            spreadsheetId: MASTER_SHEET_ID,
            range: "A:E",
            valueInputOption: "RAW",
            requestBody: {
                values: [[name.trim(), phone.toString().trim(), textoTurnoNuevo, fechaHoyReal, slug]]
            }
        });

        delete globalCache[slug];
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. LOGIN
app.post("/login", async (req, res) => {
    try {
        const slug = getCleanSlug(req.body.slug);
        const { password } = req.body;
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        
        if (user && String(user.password) === String(password)) {
            return res.json({ success: true, slug: user.slug });
        }
        res.status(401).json({ success: false, error: "Credenciales inválidas" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. ADMIN STATS & CONFIG
app.get("/admin-stats/:slug", async (req, res) => {
    const slug = getCleanSlug(req.params.slug);
    const now = Date.now();

    if (globalCache[slug] && (now - globalCache[slug].timestamp < CACHE_DURATION)) {
        return res.json(globalCache[slug].data);
    }

    try {
        const { data: user, error: userError } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        
        if (userError || !user) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: MASTER_SHEET_ID, 
            range: "A:E" 
        });
        
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

            const [fechaParte, horaParte] = partes;
            const [dia, mes] = fechaParte.split("/").map(Number);

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
                hora: horaParte,
                rawTurno: r[2]
            });
        });

        const finalData = {
            stats: {
                turnosHoy,
                turnosMes: turnosMesActual,
                ingresosEstimados: turnosMesActual * (user.precio || 0),
                promedioDiario: diaHoyNum > 0 ? Math.round((turnosMesActual * (user.precio || 0)) / diaHoyNum) : 0,
                chartData: Object.keys(semanas).map(key => ({ label: key, turnos: semanas[key] })),
                businessName: user.business_name || user.slug,
                config: {
                    duracion: parseInt(user.duracion_turno) || 30,
                    h_ini_j: user.hora_inicio_jornada,
                    h_fin_j: user.hora_fin_jornada,
                    d_ini: user.descanso_inicio,
                    d_fin: user.descanso_fin,
                    precio: user.precio || 0,
                    mp_status: user.mp_access_token ? "Conectado" : "Desconectado"
                },
                turnosLista: turnosLista.sort((a, b) => {
                    return a.hora.localeCompare(b.hora);
                })
            }
        };

        globalCache[slug] = { timestamp: now, data: finalData };
        res.json(finalData);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8. CANCELAR
app.post("/cancel-appointment", async (req, res) => {
    try {
        const { slug, rawTurno } = req.body;
        const cleanSlug = getCleanSlug(slug);

        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: "A:E", 
        });

        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(r => r[2] === rawTurno && r[4] === cleanSlug);

        if (rowIndex === -1) return res.status(404).json({ error: "Turno no encontrado" });

        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID });
        const sheetIdReal = spreadsheet.data.sheets[0].properties.sheetId;

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: MASTER_SHEET_ID,
            requestBody: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetId: sheetIdReal, 
                            dimension: "ROWS",
                            startIndex: rowIndex,
                            endIndex: rowIndex + 1
                        }
                    }
                }]
            }
        });

        delete globalCache[cleanSlug];
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
