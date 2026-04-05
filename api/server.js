import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";
import { MercadoPagoConfig, Preference } from "mercadopago";
import fetch from "node-fetch";

const app = express();

// --- CONFIGURACIÓN GLOBAL ---
const MASTER_SHEET_ID = "1CYF1IJFEKibbkXTKco-o13ZbMo6KpkT5oJj35Z3q4hg";
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwkhk4hbHBAiGZlGEhyMfmnBPduyWBeL03p_GYY8PVPNJuuvdugtq2-gNOqmScp2HJS/exec";

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
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

// --- LÓGICA DE TOKENS ---
async function handleTokenDiscount(slug) {
    try {
        const { data: user, error: userError } = await supabase
            .from('usuarios')
            .select('plan, tokens')
            .eq('slug', slug)
            .single();

        if (userError || !user) return;

        // Si es premium, no descontamos (tiene 100k tokens de base)
        if (user.plan === 'premium') return;

        // Si es gratis, bajamos 1
        if (user.tokens > 0) {
            await supabase
                .from('usuarios')
                .update({ tokens: user.tokens - 1 })
                .eq('slug', slug);
        }
    } catch (e) {
        console.error("Error al descontar token:", e.message);
    }
}

// --- RUTAS DE SISTEMA ---
app.get("/", (req, res) => {
    res.send("🚀 NegoSocio API Server Is Online (Full Mode)");
});

// --- MERCADO PAGO: PREFERENCIA ---
app.post("/api/create-preference", async (req, res) => {
    try {
        const { name, phone, fecha, hora, slug } = req.body;
        const cleanSlug = getCleanSlug(slug);

        const { data: user, error: userError } = await supabase
            .from('usuarios')
            .select('*')
            .eq('slug', cleanSlug)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: "Negocio no encontrado." });
        }

        // --- BLOQUEO POR VENCIMIENTO PREMIUM ---
        if (user.plan === 'premium') {
            const ahora = new Date();
            const vencimiento = user.subscription_expiry ? new Date(user.subscription_expiry) : null;
            if (!vencimiento || ahora > vencimiento) {
                return res.status(403).json({ 
                    error: "Servicio suspendido", 
                    message: "Este negocio tiene las reservas pausadas temporalmente." 
                });
            }
        }

        let precioReal = 0;
        let conceptoPago = "Total";

        if (user.metodo_pago === 'sena') {
            precioReal = Number(user.monto_sena) || 0;
            conceptoPago = "Seña";
        } else {
            precioReal = Number(user.precio) || 0;
            conceptoPago = "Total";
        }

        if (precioReal <= 0) return res.json({ isFree: true });

        if (!user.mp_access_token) {
            return res.status(400).json({ error: "Este negocio no configuró Mercado Pago." });
        }

        const clientMP = new MercadoPagoConfig({ accessToken: user.mp_access_token });
        const preference = new Preference(clientMP);

        const response = await preference.create({
            body: {
                items: [{
                    title: `Reserva ${conceptoPago}: ${fecha} - ${hora}hs`,
                    unit_price: precioReal,
                    quantity: 1,
                    currency_id: "ARS"
                }],
                metadata: { 
                    nombre: name, 
                    telefono: phone, 
                    fecha: fecha, 
                    hora: hora, 
                    slug: cleanSlug,
                    tipo_pago: user.metodo_pago || 'total'
                },
                notification_url: "https://framerturnero.onrender.com/webhook",
                back_urls: { 
                    success: "https://negosocio.framer.website/success",
                    failure: "https://negosocio.framer.website/dashboard",
                    pending: "https://negosocio.framer.website/dashboard"
                },
                auto_return: "approved"
            },
        });

        res.json({ payment_url: response.init_point });

    } catch (error) {
        console.error("Error en create-preference:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- MERCADO PAGO: OAUTH ---
app.get("/oauth-callback", async (req, res) => {
    const { code, state: slug } = req.query;
    if (!code || !slug) return res.status(400).send("Datos inválidos.");

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
            await supabase.from('usuarios').update({ mp_access_token: data.access_token }).eq('slug', slug);
            res.redirect(`https://negosocio.framer.website/dashboard?status=mp_success`);
        } else {
            res.redirect(`https://negosocio.framer.website/dashboard?status=mp_error`);
        }
    } catch (error) {
        res.status(500).send("Error vinculando cuenta.");
    }
});

// --- WEBHOOK UNIFICADO ---
app.post("/webhook", async (req, res) => {
    const { query, body } = req;
    
    // --- 1. LÓGICA PARA PAGOS DE TURNOS ---
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
                const textoTurnoNuevo = `${partes[2]}/${partes[1]} - ${hora}`;
                const fechaHoyReal = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

                const sheets = await getSheets();
                
                await sheets.spreadsheets.values.append({
                    spreadsheetId: MASTER_SHEET_ID,
                    range: "A:E",
                    valueInputOption: "RAW",
                    requestBody: { values: [[nombre.trim(), telefono.toString().trim(), textoTurnoNuevo, fechaHoyReal, slug]] }
                });

                await handleTokenDiscount(slug);
                delete globalCache[slug];
                console.log(`✅ Turno agendado para el socio: ${slug}`);
            }
        } catch (e) { 
            console.error("❌ Error Webhook Payment:", e.message); 
        }
    }

// --- 2. LÓGICA PARA SUSCRIPCIÓN PREMIUM ---
    if (body.type === "subscription_preapproval") {
        try {
            // Mercado Pago puede mandar el ID en distintos lugares según la versión
            const subId = body.data?.id || body.id; 
            
            if (!subId) {
                console.log("⚠️ Webhook de suscripción sin ID válido");
                return res.sendStatus(200);
            }

            console.log(`🔎 Buscando suscripción en MP: ${subId}`);

            const response = await fetch(`https://api.mercadopago.com/preapproval/${subId}`, {
                headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
            });
            const subData = await response.json();

            // "authorized" significa que el pago de la suscripción entró bien
            if (subData.status === "authorized" || subData.status === "active") {
                const fechaVencimiento = new Date();
                fechaVencimiento.setMonth(fechaVencimiento.getMonth() + 1);
                fechaVencimiento.setDate(fechaVencimiento.getDate() + 2); 

                const { data: userUpdated, error } = await supabase
                    .from('usuarios')
                    .update({ 
                        plan: 'premium', 
                        tokens: 100000,
                        subscription_expiry: fechaVencimiento.toISOString()
                    })
                    .eq('email', subData.payer_email.trim().toLowerCase())
                    .select(); // Agregamos select para confirmar en el log

                if (error) throw error;
                
                if (userUpdated && userUpdated.length > 0) {
                    console.log(`🚀 PREMIUM ACTIVADO con éxito para: ${subData.payer_email}`);
                } else {
                    console.log(`⚠️ Se recibió el pago pero no se encontró usuario con el mail: ${subData.payer_email}`);
                }
            }
        } catch (e) { 
            console.error("❌ Error Webhook Suscripción:", e.message); 
        }
    }

    res.sendStatus(200);
});

app.post("/api/create-subscription", async (req, res) => {
    try {
        const { email } = req.body;
        
        const response = await fetch("https://api.mercadopago.com/preapproval_plan", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                reason: "Plan Premium NegoSocio",
                auto_recurring: {
                    frequency: 1,
                    frequency_type: "months",
                    transaction_amount: 5000,
                    currency_id: "ARS"
                },
                back_url: "https://negosocio.framer.website/verificar-cuenta?email=" + email,
                status: "active"
            })
        });

        const plan = await response.json();
        res.json({ sandbox_init_point: plan.init_point }); 
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
    
// --- GESTIÓN DE TURNOS ---
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

        const { data: user, error: userError } = await supabase
            .from('usuarios')
            .select('*')
            .eq('slug', slug)
            .single();

        if (userError || !user) {
            return res.status(404).json({ success: false, error: "Negocio no encontrado." });
        }

        if (user.plan === 'premium') {
            const ahoraArg = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
            const vencimiento = user.subscription_expiry ? new Date(user.subscription_expiry) : null;

            if (!vencimiento || ahoraArg > vencimiento) {
                return res.status(403).json({ 
                    success: false, 
                    error: "Servicio suspendido temporalmente por el administrador." 
                });
            }
        }

        if (user.plan === 'gratis' && user.tokens <= 0) {
            return res.status(403).json({ success: false, error: "Sin tokens disponibles en este negocio." });
        }

        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: "A:E" });
        const rows = response.data.values || [];

        if (rows.some(row => row[1] === phone.toString().trim() && row[4] === slug)) {
            return res.status(400).json({ success: false, error: "Ya tenés un turno agendado en este negocio." });
        }

        const partes = fecha.split("-");
        const textoTurnoNuevo = `${partes[2]}/${partes[1]} - ${hora}`;
        const fechaHoyReal = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        await sheets.spreadsheets.values.append({
            spreadsheetId: MASTER_SHEET_ID,
            range: "A:E",
            valueInputOption: "RAW",
            requestBody: { 
                values: [[
                    name.trim(), 
                    phone.toString().trim(), 
                    textoTurnoNuevo, 
                    fechaHoyReal, 
                    slug
                ]] 
            }
        });

        await handleTokenDiscount(slug);
        delete globalCache[slug];
        res.json({ success: true });

    } catch (e) { 
        console.error("Error en create-booking:", e.message);
        res.status(500).json({ error: e.message }); 
    }
});

// --- REGISTRO Y AUTH ---
app.post("/api/request-verification", async (req, res) => {
    try {
        const { email, business, password, plan, precio, duracion_turno, tokens, horarios } = req.body;
        if (!email || !business || !password) return res.status(400).json({ error: "Faltan datos." });

        const googleRes = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({
                action: "sendCode",
                email: email.trim().toLowerCase(),
                usuario: business,
                password, plan, precio, duracion_turno, tokens,
                horarios: typeof horarios === "string" ? horarios : JSON.stringify(horarios)
            })
        });

        const text = await googleRes.text();
        const result = JSON.parse(text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1));
        if (result.status === "success") res.json({ success: true });
        else res.status(500).json({ error: result.message });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/verify-and-register", async (req, res) => {
    try {
        const { 
            email, 
            code, 
            business_name, 
            nombre_persona, 
            precio, 
            duracion_turno, 
            plan, 
            horarios, 
            telefono 
        } = req.body;
        
        // 1. Validar el código con Google Apps Script
        const googleRes = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ 
                action: "verifyCode", 
                email: email.trim().toLowerCase(), 
                code: code.toString().trim() 
            })
        });
        
        const result = await googleRes.json();

        if (result.status === "valid") {
            // 2. Generar Slug limpio a partir del nombre del negocio
            const finalName = business_name || result.usuario || "Negocio";
            const cleanSlug = finalName
                .toLowerCase()
                .trim()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "") // Quita acentos
                .replace(/\s+/g, '-')           // Espacios por guiones
                .replace(/[^a-z0-9-]/g, '');    // Quita caracteres raros
            
            // 3. Lógica de Plan y Vencimiento Inicial
            const isPremium = plan === 'premium';
            let fechaVencimientoInicial = null;
            
            if (isPremium) {
                // Le damos 2 horas de gracia inicial para que el Webhook tenga tiempo de procesar el pago real
                const ahora = new Date();
                ahora.setHours(ahora.getHours() + 2); 
                fechaVencimientoInicial = ahora.toISOString();
            }

            // 4. Insertar en la tabla de Usuarios de Supabase
            const { error } = await supabase.from('usuarios').insert([{
                slug: cleanSlug,
                email: email.trim().toLowerCase(),
                nombre_persona: nombre_persona || "Dueño",
                business_name: finalName,
                password: String(result.password), // Viene del script de Google
                sheet_id: MASTER_SHEET_ID,
                precio: parseInt(precio) || 0,
                duracion_turno: parseInt(duracion_turno) || 30,
                horarios: horarios || {},
                plan: isPremium ? 'premium' : 'gratis',
                tokens: isPremium ? 100000 : 50,
                telefono: telefono || null,
                metodo_pago: 'none', // Se actualiza luego cuando conecte MP
                subscription_expiry: fechaVencimientoInicial,
                excepciones: [] // Array vacío por defecto
            }]);

            if (error) {
                // Si el error es por slug duplicado, avisamos
                if (error.code === '23505') {
                    return res.status(400).json({ error: "Este nombre de negocio ya está registrado." });
                }
                throw error;
            }

            // 5. Respuesta exitosa (el slug es vital para la redirección en Framer)
            console.log(`✨ Nuevo usuario registrado: ${cleanSlug} (${plan})`);
            res.json({ 
                success: true, 
                slug: cleanSlug,
                message: "Cuenta verificada y creada con éxito."
            });

        } else {
            // El código no coincide o expiró en la planilla
            res.status(400).json({ error: "El código de verificación no es válido o ya expiró." });
        }
    } catch (e) { 
        console.error("❌ Error crítico en registro:", e.message);
        res.status(500).json({ error: "Hubo un problema al crear tu cuenta. Intentá de nuevo." }); 
    }
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

app.post("/api/request-password-reset", async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        if (!email || !newPassword) return res.status(400).json({ error: "Faltan datos." });

        const { data: user, error } = await supabase
            .from('usuarios')
            .select('slug')
            .eq('email', email.trim().toLowerCase())
            .single();

        if (error || !user) return res.status(404).json({ error: "No existe una cuenta con ese correo." });

        const googleRes = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({
                action: "resetPassword",
                email: email.trim().toLowerCase(),
                newPassword: newPassword
            })
        });

        const text = await googleRes.text();
        const result = JSON.parse(text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1));
        
        if (result.status === "success") res.json({ success: true });
        else res.status(500).json({ error: result.message });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/verify-and-reset-password", async (req, res) => {
    try {
        const { email, code } = req.body;
        const googleRes = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ 
                action: "verifyCode", 
                email: email.trim().toLowerCase(), 
                code: code.toString().trim() 
            })
        });
        const result = await googleRes.json();
        if (result.status === "valid") {
            const { error } = await supabase
                .from('usuarios')
                .update({ password: String(result.password) })
                .eq('email', email.trim().toLowerCase());
            if (error) throw error;
            res.json({ success: true });
        } else {
            res.status(400).json({ error: "Código incorrecto o expirado." });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ADMIN Y CONFIG ---
app.get("/admin-stats/:slug", async (req, res) => {
    const slug = getCleanSlug(req.params.slug);
    const now = Date.now();

    // 1. Verificación de Caché
    if (globalCache[slug] && (now - globalCache[slug].timestamp < CACHE_DURATION)) {
        return res.json(globalCache[slug].data);
    }

    try {
        // 2. Obtener datos del usuario en Supabase
        const { data: user, error: userError } = await supabase
            .from('usuarios')
            .select('*')
            .eq('slug', slug)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        // 3. Lógica de Control de Suscripción Premium
        const ahoraArg = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
        
        if (user.plan === 'premium') {
            const vencimiento = user.subscription_expiry ? new Date(user.subscription_expiry) : null;

            // Si el plan es premium pero no hay fecha o ya pasó, bloqueamos con 402
            if (!vencimiento || ahoraArg > vencimiento) {
                return res.status(402).json({ 
                    error: "Suscripción Premium vencida",
                    expired: true,
                    message: "Socio, tu suscripción Premium ha expirado. Por favor, renovala para seguir recibiendo turnos.",
                    slug: user.slug
                });
            }
        }

        // 4. Obtener turnos desde Google Sheets
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: MASTER_SHEET_ID, 
            range: "A:E" 
        });
        
        const allRows = response.data.values || [];
        // Filtramos las filas: mantenemos el encabezado (i===0) y las que pertenecen a este negocio (slug)
        const rows = allRows.filter((r, i) => i === 0 || (r[4] && getCleanSlug(r[4]) === slug));

        // 5. Procesamiento de Estadísticas
        const mesActual = ahoraArg.getMonth() + 1;
        const diaHoyNum = ahoraArg.getDate();
        
        let turnosHoy = 0;
        let turnosMesActual = 0;
        let turnosLista = [];
        let semanas = { "Sem 1": 0, "Sem 2": 0, "Sem 3": 0, "Sem 4": 0 };

        rows.forEach((r, i) => {
            // Saltamos encabezado o filas vacías
            if (i === 0 || !r[2]) return;

            // El formato esperado en la celda es "DD/MM - HH:mm"
            const partes = r[2].toString().split(" - ");
            if (partes.length < 2) return;
            
            const [dia, mes] = partes[0].split("/").map(Number);
            
            // Si el turno pertenece al mes en curso
            if (mes === mesActual) {
                turnosMesActual++;
                
                // Si es hoy
                if (dia === diaHoyNum) {
                    turnosHoy++;
                }

                // Clasificación por semanas para el gráfico
                if (dia <= 7) semanas["Sem 1"]++;
                else if (dia <= 14) semanas["Sem 2"]++;
                else if (dia <= 21) semanas["Sem 3"]++;
                else semanas["Sem 4"]++;
            }

            // Construimos el objeto para la lista de turnos del admin
            turnosLista.push({ 
                nombre: r[0], 
                telefono: r[1], 
                fecha: `2026-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`, 
                hora: partes[1], 
                rawTurno: r[2] 
            });
        });

        // 6. Estructura final de respuesta
        const finalData = {
            stats: {
                nombre_persona: user.nombre_persona,
                turnosHoy, 
                turnosMes: turnosMesActual,
                ingresosEstimados: turnosMesActual * (user.precio || 0),
                promedioDiario: diaHoyNum > 0 ? Math.round((turnosMesActual * (user.precio || 0)) / diaHoyNum) : 0,
                chartData: Object.keys(semanas).map(key => ({ label: key, turnos: semanas[key] })),
                businessName: user.business_name,
                tokens: user.tokens,
                horarios: user.horarios,
                config: { 
                    duracion: user.duracion_turno, 
                    precio: user.precio, 
                    monto_sena: user.monto_sena || 0,
                    metodo_pago: user.metodo_pago || 'none',
                    mp_status: user.mp_access_token ? "Conectado" : "Desconectado", 
                    plan: user.plan,
                    vencimiento: user.subscription_expiry,
                    excepciones: user.excepciones || [] 
                },
                // Invertimos la lista para mostrar los más recientes arriba
                turnosLista: turnosLista.reverse()
            }
        };

        // 7. Guardar en caché y enviar
        globalCache[slug] = { timestamp: now, data: finalData };
        res.json(finalData);

    } catch (e) { 
        console.error("❌ Error crítico en admin-stats:", e.message);
        res.status(500).json({ error: "Error al procesar las estadísticas del negocio." }); 
    }
});

app.post("/update-settings", async (req, res) => {
    try {
        const { slug, precio, horarios, duracion_turno, ocupados, monto_sena, cobrar_total_activado, metodo_pago } = req.body;
        const cleanSlug = getCleanSlug(slug);

        const numPrecio = parseInt(precio) || 0;
        const numSena = parseInt(monto_sena) || 0;

        let metodoPagoFinal = metodo_pago;
        if (!metodoPagoFinal) {
            if (numSena > 0) metodoPagoFinal = 'sena';
            else if (cobrar_total_activado) metodoPagoFinal = 'total';
            else metodoPagoFinal = 'none';
        }

        const updateData = { 
            precio: numPrecio,
            monto_sena: numSena,
            metodo_pago: metodoPagoFinal,
            duracion_turno: parseInt(duracion_turno) || 30
        };

        if (horarios) updateData.horarios = horarios;
        if (ocupados) updateData.excepciones = ocupados;

        const { error: updateError } = await supabase
            .from('usuarios')
            .update(updateData)
            .eq('slug', cleanSlug);

        if (updateError) throw updateError;
        delete globalCache[cleanSlug];
        res.json({ success: true });
    } catch (e) { 
        console.error("Error en update-settings:", e.message);
        res.status(500).json({ error: e.message }); 
    }
});

app.post("/cancel-appointment", async (req, res) => {
    try {
        const { slug, rawTurno } = req.body;
        const cleanSlug = getCleanSlug(slug);
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: "A:E" });
        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(r => r[2] === rawTurno && r[4] === cleanSlug);
        if (rowIndex === -1) return res.status(404).json({ error: "No encontrado" });
        
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

app.get("/verify-session", async (req, res) => {
    try {
        const slug = getCleanSlug(req.query.u);
        const { data: user } = await supabase.from('usuarios').select('slug').eq('slug', slug).single();
        res.json({ active: !!user });
    } catch (e) { 
        res.json({ active: false }); 
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor NegoSocio en puerto ${PORT}`));
