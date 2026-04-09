import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";
import { MercadoPagoConfig, Preference } from "mercadopago";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();

// --- CONFIGURACIÓN GLOBAL ---
const MASTER_SHEET_ID = "1CYF1IJFEKibbkXTKco-o13ZbMo6KpkT5oJj35Z3q4hg";
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyFCX6iK4N6bkA9nKQ8wgN8EawC-79-bxyuac7MSsXjukef-Q6OlBktXi3jPffzVVBR/exec";
const registrosTemporales = {};

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

app.post("/webhook", async (req, res) => {
    const { query, body } = req;

    try {
        console.log(`📩 Webhook recibido. Tipo: ${body.type || query.topic}`);

        // --- A. LÓGICA PARA PAGOS DE TURNOS (Venta única de clientes) ---
        if (query.topic === "payment" || body.type === "payment") {
            const paymentId = query.id || body.data?.id;
            if (paymentId) {
                const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
                });
                const paymentData = await paymentResponse.json();

                if (paymentData.status === "approved" && paymentData.metadata) {
                    const { nombre, telefono, fecha, hora, slug: rawSlug } = paymentData.metadata;
                    
                    // Limpieza de slug para asegurar coincidencia
                    const slug = rawSlug.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                    
                    const partes = fecha.split("-");
                    const textoTurnoNuevo = `${partes[2]}/${partes[1]} - ${hora}`;
                    const fechaHoyReal = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

                    const sheets = await getSheets();
                    await sheets.spreadsheets.values.append({
                        spreadsheetId: MASTER_SHEET_ID,
                        range: "A:E",
                        valueInputOption: "RAW",
                        requestBody: { 
                            values: [[
                                nombre.trim(), 
                                telefono.toString().trim(), 
                                textoTurnoNuevo, 
                                fechaHoyReal, 
                                slug
                            ]] 
                        }
                    });

                    // Descontar token al dueño del negocio
                    if (typeof handleTokenDiscount === 'function') await handleTokenDiscount(slug);
                    
                    // Limpiar caché para que el dashboard muestre el nuevo turno
                    delete globalCache[slug];
                    console.log(`✅ Turno agendado y token descontado para el negocio: ${slug}`);
                }
            }
        }

        // --- B. LÓGICA PARA SUSCRIPCIÓN PREMIUM (Registro/Renovación con Backup en Sheets) ---
        if (body.type === "subscription_preapproval" || body.type === "subscription_authorized") {
            const subId = body.data?.id || body.id;
            
            if (subId) {
                const response = await fetch(`https://api.mercadopago.com/preapproval/${subId}`, {
                    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
                });
                const subData = await response.json();

                // Solo procesamos si el pago está aprobado (authorized o active)
                if (subData.status === "authorized" || subData.status === "active") {
                    const userEmail = subData.payer_email.trim().toLowerCase();
                    console.log(`💳 Confirmado pago Premium para: ${userEmail}`);

                    // 1. RECUPERACIÓN DE DATOS (Primero RAM, si falla busca en Sheets)
                    let datosSocio = registrosTemporales[userEmail];

                    if (!datosSocio) {
                        console.log(`⚠️ RAM vacía para ${userEmail}. Buscando en hoja "Premium Temp"...`);
                        const sheets = await getSheets();
                        const rangeRes = await sheets.spreadsheets.values.get({
                            spreadsheetId: MASTER_SHEET_ID,
                            range: "Premium Temp!A:B"
                        });
                        
                        const rows = rangeRes.data.values || [];
                        // Buscamos de abajo hacia arriba para obtener el registro más reciente de ese email
                        const filaEncontrada = [...rows].reverse().find(row => row[0] === userEmail);
                        
                        if (filaEncontrada && filaEncontrada[1]) {
                            try {
                                datosSocio = JSON.parse(filaEncontrada[1]);
                                console.log(`✅ Datos recuperados exitosamente desde Backup en Sheets.`);
                            } catch (err) {
                                console.error("❌ Error al parsear JSON desde Sheets:", err);
                            }
                        }
                    }

                    // 2. CONFIGURACIÓN DE TIEMPOS Y TOKEN DE SESIÓN
                    const nuevaFechaVencimiento = new Date();
                    nuevaFechaVencimiento.setMonth(nuevaFechaVencimiento.getMonth() + 1);
                    nuevaFechaVencimiento.setDate(nuevaFechaVencimiento.getDate() + 2); // 2 días de gracia

                    let magicToken = datosSocio?.access_token || "session_" + crypto.randomBytes(8).toString('hex');
                    try {
                        if (subData.back_url) {
                            const urlObj = new URL(subData.back_url);
                            if (urlObj.searchParams.get("at")) {
                                magicToken = urlObj.searchParams.get("at");
                            }
                        }
                    } catch (e) {
                        console.log("No se pudo extraer token de back_url.");
                    }

                    // 3. GENERACIÓN DE SLUG DEFINITIVO (Sin acentos ni caracteres raros)
                    const nombreBase = datosSocio?.business_name || userEmail.split('@')[0];
                    const realSlug = nombreBase
                        .toLowerCase()
                        .trim()
                        .normalize("NFD")
                        .replace(/[\u0300-\u036f]/g, "") // Quita acentos
                        .replace(/\s+/g, '-')
                        .replace(/[^a-z0-9-]/g, '');

                    console.log(`🚀 Sincronizando usuario Premium: ${realSlug}`);

                    // 4. UPSERT EN SUPABASE
                    const { error: upsertError } = await supabase.from('usuarios').upsert({
                        email: userEmail,
                        slug: realSlug,
                        business_name: datosSocio?.business_name || "Mi Negocio Premium",
                        nombre_persona: datosSocio?.nombre_persona || "Dueño Premium",
                        precio: parseInt(datosSocio?.precio) || 0,
                        duracion_turno: parseInt(datosSocio?.duracion_turno) || 30,
                        horarios: datosSocio?.horarios || {},
                        telefono: datosSocio?.telefono || null,
                        plan: 'premium',
                        tokens: 100000,
                        access_token: magicToken,
                        subscription_expiry: nuevaFechaVencimiento.toISOString(),
                        password: datosSocio?.password || "auth-via-payment",
                        sheet_id: MASTER_SHEET_ID,
                        metodo_pago: 'mercadopago'
                    }, { onConflict: 'email' });

                    if (upsertError) {
                        console.error("❌ Error de Supabase al guardar Premium:", upsertError.message);
                    } else {
                        console.log(`✨ ¡Usuario ${realSlug} activado correctamente!`);
                        // Limpieza de datos temporales para liberar RAM
                        delete registrosTemporales[userEmail];
                        delete globalCache[realSlug];
                    }
                }
            }
        }

        // Siempre responder 200 a Mercado Pago para evitar reintentos infinitos
        res.sendStatus(200);

    } catch (e) {
        console.error("❌ Error crítico dentro del Webhook:", e.message);
        res.sendStatus(200);
    }
});

app.post("/api/pre-register-premium", async (req, res) => {
    // Desestructuramos todos los campos necesarios que vienen desde el DataGuardian de Framer
    const { 
        email, 
        business_name, 
        nombre_persona, 
        precio, 
        duracion_turno, 
        horarios, 
        telefono, 
        plan,
        password 
    } = req.body;
    
    // Validación de seguridad básica
    if (!email) {
        return res.status(400).json({ error: "El email es requerido para el pre-registro." });
    }

    const emailKey = email.trim().toLowerCase();

    try {
        // 1. PERSISTENCIA EN MEMORIA (Para acceso rápido del Webhook)
        // Verificamos si ya existe algo (como el access_token generado en create-subscription)
        const registroExistente = registrosTemporales[emailKey] || {};

        registrosTemporales[emailKey] = {
            ...registroExistente,
            business_name: business_name || registroExistente.business_name,
            nombre_persona: nombre_persona || registroExistente.nombre_persona,
            precio: precio || registroExistente.precio,
            duracion_turno: duracion_turno || registroExistente.duracion_turno,
            horarios: horarios || registroExistente.horarios,
            telefono: telefono || registroExistente.telefono,
            plan: plan || 'premium',
            password: password || registroExistente.password,
            timestamp: Date.now()
        };

        // 2. PERSISTENCIA EN GOOGLE SHEETS (Respaldo contra reinicios del servidor)
        const sheets = await getSheets();
        const fechaHoy = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        // Convertimos el objeto a string para guardarlo en una sola celda como JSON
        const datosBackup = JSON.stringify({
            business_name,
            nombre_persona,
            precio: parseInt(precio) || 0,
            duracion_turno: parseInt(duracion_turno) || 30,
            horarios,
            telefono,
            plan: plan || 'premium',
            password: password || "auth-via-payment"
        });

        // Guardamos en la pestaña "Premium Temp"
        // Columna A: Email | Columna B: Datos JSON | Columna C: Fecha
        await sheets.spreadsheets.values.append({
            spreadsheetId: MASTER_SHEET_ID,
            range: "Premium Temp!A:C",
            valueInputOption: "RAW",
            requestBody: { 
                values: [[emailKey, datosBackup, fechaHoy]] 
            }
        });

        console.log(`✅ Registro Temporal completado para: ${emailKey}`);
        console.log(`📦 Datos guardados en RAM y en hoja "Premium Temp"`);

        res.json({ 
            success: true, 
            message: "Datos protegidos en backup. Procediendo al flujo de pago." 
        });

    } catch (e) {
        console.error("❌ Error crítico en pre-register-premium:", e.message);
        // Aunque falle Sheets, intentamos responder success si se guardó en RAM 
        // para no trabar al usuario, pero avisamos en consola.
        res.status(500).json({ 
            error: "Error interno al procesar el backup de datos.",
            details: e.message 
        });
    }
});

app.post("/api/create-subscription", async (req, res) => {
    try {
        const { email } = req.body;

        // Validación de entrada
        if (!email) {
            return res.status(400).json({ 
                error: "El email es obligatorio para generar la suscripción." 
            });
        }

        const userEmailLimpio = email.toLowerCase().trim();

        // 1. Generamos el slug a partir del email para la vuelta al dashboard
        // Esto sirve como identificador visual en la URL de regreso
        const userSlug = userEmailLimpio.split('@')[0].replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

        // 2. Generamos un Magic Token aleatorio y seguro
        // Este token se envía en la back_url y se guarda en registrosTemporales para que el Webhook lo use
        const magicToken = crypto.randomBytes(16).toString('hex');

        // --- NUEVO: GUARDADO PREVENTIVO EN MEMORIA ---
        // Si el usuario ya hizo el pre-register, vinculamos el token a sus datos existentes
        if (registrosTemporales[userEmailLimpio]) {
            registrosTemporales[userEmailLimpio].access_token = magicToken;
            console.log(`🔑 Magic Token vinculado a datos temporales de: ${userEmailLimpio}`);
        } else {
            // Si por alguna razón no hay pre-register, creamos el espacio para no perder el token
            registrosTemporales[userEmailLimpio] = { access_token: magicToken };
            console.log(`⚠️ Advertencia: Creando registro temporal solo para token (faltó pre-register) para: ${userEmailLimpio}`);
        }

        // 3. Llamada a la API de Mercado Pago para crear la suscripción (Preapproval)
        const response = await fetch("https://api.mercadopago.com/preapproval", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                reason: "Plan Premium NegoSocio",
                payer_email: userEmailLimpio,
                auto_recurring: {
                    frequency: 1,
                    frequency_type: "months",
                    transaction_amount: 15, // Ajustar al valor real
                    currency_id: "ARS"
                },
                // La back_url lleva el slug (u) y el magic token (at)
                // Es vital que el "at" coincida con el que guardamos en registrosTemporales
                back_url: `https://negosocio.framer.website/dashboard?u=${userSlug}&at=${magicToken}`,
                status: "pending"
            })
        });

        const subscription = await response.json();

        // Manejo de errores detallado de la API de Mercado Pago
        if (!response.ok) {
            console.error("❌ Error de MP al generar suscripción:", JSON.stringify(subscription, null, 2));
            return res.status(response.status).json({ 
                error: subscription.message || "No se pudo conectar con Mercado Pago. Reintentá.",
                details: subscription.cause || []
            });
        }

        // Obtenemos el link de pago
        const checkoutUrl = subscription.init_point || subscription.sandbox_init_point;

        if (!checkoutUrl) {
            console.error("❌ No se recibió init_point de MP:", subscription);
            throw new Error("No se encontró la URL de pago en la respuesta de Mercado Pago.");
        }

        console.log(`🔗 Link de suscripción Premium generado para: ${userEmailLimpio}`);
        console.log(`🔑 Magic Token asociado: ${magicToken}`);
        
        // Enviamos la URL y la confirmación al frontend
        res.json({ 
            success: true,
            init_point: checkoutUrl,
            message: "Link de suscripción generado correctamente.",
            token_generated: magicToken 
        }); 

    } catch (e) {
        console.error("❌ Error crítico creando suscripción:", e.message);
        res.status(500).json({ 
            error: "Error interno al procesar la suscripción.",
            message: e.message 
        });
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
        
        if (!email || !business || !password) {
            return res.status(400).json({ error: "Faltan datos obligatorios (email, negocio o pass)." });
        }

        const googleRes = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({
                action: "sendCode",
                email: email.trim().toLowerCase(),
                usuario: business, // Google espera 'usuario'
                password, plan, precio, duracion_turno, tokens,
                horarios: typeof horarios === "string" ? horarios : JSON.stringify(horarios)
            })
        });

        const text = await googleRes.text();
        
        // Buscamos el JSON de forma segura
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        
        if (start === -1 || end === -1) {
            console.error("Respuesta no válida de Google:", text);
            return res.status(500).json({ error: "Google Apps Script devolvió un formato inválido." });
        }

        const result = JSON.parse(text.substring(start, end + 1));
        
        if (result.status === "success") {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: result.message || "Error en Google Script" });
        }
    } catch (e) { 
        console.error("Error en request-verification:", e.message);
        res.status(500).json({ error: "Error de conexión con el servicio de correos." }); 
    }
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
                // Le damos 24 horas de gracia inicial para que entre al dashboard
                const ahora = new Date();
                ahora.setHours(ahora.getHours() + 24); 
                fechaVencimientoInicial = ahora.toISOString();
            }

            // --- NUEVO: GENERACIÓN DE MAGIC TOKEN PARA LOGIN AUTOMÁTICO ---
            const magicToken = crypto.randomBytes(16).toString('hex');

            // 4. Insertar en la tabla de Usuarios de Supabase
            const { error } = await supabase.from('usuarios').insert([{
                slug: cleanSlug,
                email: email.trim().toLowerCase(),
                nombre_persona: nombre_persona || "Dueño",
                business_name: finalName,
                password: String(result.password),
                sheet_id: MASTER_SHEET_ID,
                precio: parseInt(precio) || 0,
                duracion_turno: parseInt(duracion_turno) || 30,
                horarios: horarios || {},
                plan: isPremium ? 'premium' : 'gratis',
                tokens: isPremium ? 100000 : 50,
                telefono: telefono || null,
                metodo_pago: 'none',
                subscription_expiry: fechaVencimientoInicial,
                excepciones: [],
                mp_access_token: null,
                access_token: magicToken // <--- GUARDAMOS EL TOKEN EN LA DB
            }]);

            if (error) {
                if (error.code === '23505') {
                    return res.status(400).json({ error: "Este nombre de negocio ya está registrado. Probá con uno similar." });
                }
                throw error;
            }

            // 5. Respuesta exitosa incluyendo el TOKEN para el frontend
            console.log(`✨ Nuevo usuario registrado: ${cleanSlug}. Magic Token generado.`);
            
            res.json({ 
                success: true, 
                slug: cleanSlug,
                at: magicToken, // <--- AHORA EL FRONTEND RECIBE EL TOKEN REAL
                message: "Cuenta verificada y creada con éxito."
            });

        } else {
            res.status(400).json({ error: "El código de verificación no es válido o ya expiró." });
        }
    } catch (e) { 
        console.error("❌ Error crítico en el proceso de registro:", e.message);
        res.status(500).json({ error: "Hubo un problema al crear tu cuenta." }); 
    }
});

app.post("/login", async (req, res) => {
    try {
        console.log("Login attempt:", req.body);
        const slug = getCleanSlug(req.body.slug);
        const { password } = req.body;

        const { data: user, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('slug', slug)
            .single();

        if (error || !user) {
            return res.status(401).json({ success: false, error: "Usuario no encontrado" });
        }

        if (String(user.password) === String(password)) {
            // --- NUEVO: Generamos un token también al loguearse manualmente ---
            const magicToken = crypto.randomBytes(16).toString('hex');
            
            await supabase
                .from('usuarios')
                .update({ access_token: magicToken })
                .eq('slug', slug);

            return res.json({ 
                success: true, 
                slug: user.slug,
                at: magicToken // <--- Se lo pasamos al front para que ProtectedRoute lo use
            });
        }

        res.status(401).json({ success: false, error: "Contraseña incorrecta" });
    } catch (e) { 
        console.error("Error en login:", e.message);
        res.status(500).json({ error: e.message }); 
    }
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
    // Si los datos están en caché y no pasaron más de 20 segundos, los devolvemos rápido.
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

        // 3. Lógica de Control de Suscripción Premium (Con Red de Seguridad para Magic Login)
        const ahoraArg = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
        
        if (user.plan === 'premium') {
            const vencimiento = user.subscription_expiry ? new Date(user.subscription_expiry) : null;
            
            // RED DE SEGURIDAD: Si tiene un access_token (o sea, acaba de entrar por login/pago), 
            // le permitimos ver las stats aunque el vencimiento esté al límite o nulo.
            const hasActiveMagicToken = user.access_token !== null;

            if (!hasActiveMagicToken) {
                // Si NO es un Magic Login, validamos el vencimiento normalmente
                if (!vencimiento || ahoraArg > vencimiento) {
                    return res.status(402).json({ 
                        error: "Suscripción Premium vencida",
                        expired: true,
                        message: "Socio, tu suscripción Premium ha expirado. Por favor, renovala para seguir recibiendo turnos.",
                        slug: user.slug
                    });
                }
            }
        }

        // 4. Obtener turnos desde Google Sheets
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: MASTER_SHEET_ID, 
            range: "A:E" 
        });
        
        const allRows = response.data.values || [];
        // Filtramos las filas: mantenemos el encabezado y las que pertenecen a este negocio (slug)
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
        const rawU = req.query.u;
        // Capturamos el Magic Token que viene en la URL como 'at'
        const magicToken = req.query.at; 

        if (!rawU) {
            console.log("⚠️ Intento de verificación sin parámetro 'u'");
            return res.json({ active: false, reason: "no_slug" });
        }

        // Limpiamos el slug con la misma función que usas en el registro/login
        const slug = getCleanSlug(rawU);
        
        console.log(`🔍 Verificando sesión para el slug: [${slug}]`);

        // IMPORTANTE: Seleccionamos tokens y access_token además de los datos básicos
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('slug, plan, subscription_expiry, access_token, tokens')
            .eq('slug', slug)
            .single();

        // Si hay error en Supabase o el usuario no existe
        if (error || !user) {
            console.log(`❌ Usuario no encontrado en DB: ${slug}`);
            return res.json({ 
                active: false, 
                reason: "user_not_found",
                debug: error ? error.message : "Not found" 
            });
        }

        // --- 1. LÓGICA DE MAGIC LOGIN (Pase VIP) ---
        // Si el usuario trae un token y ese token coincide con el que guardó el Webhook...
        if (magicToken && user.access_token === magicToken) {
            console.log(`✨ Magic Login exitoso para: ${slug}. Limpiando token usado...`);
            
            // Borramos el token de la DB para que el link no sirva una segunda vez (Seguridad)
            await supabase
                .from('usuarios')
                .update({ access_token: null })
                .eq('slug', slug);
            
            // Retornamos éxito inmediato saltándonos otras validaciones
            return res.json({ 
                active: true, 
                slug: user.slug, 
                plan: user.plan,
                magicLogin: true 
            });
        }

        // --- 2. LÓGICA DE BLOQUEO (402 PAYMENT REQUIRED) ---

        // CASO A: Usuario Premium con suscripción vencida
        if (user.plan === 'premium') {
            if (user.subscription_expiry) {
                const ahora = new Date();
                const vencimiento = new Date(user.subscription_expiry);

                if (ahora > vencimiento) {
                    console.log(`🚫 Suscripción vencida para ${slug}. Venció el: ${vencimiento}`);
                    // Devolvemos 402 para que el ProtectedRoute de Framer sepa que debe ir a /renovar
                    return res.status(402).json({ 
                        active: false, 
                        reason: "expired",
                        expiry: user.subscription_expiry 
                    });
                }
            } else {
                console.log(`⚠️ Usuario ${slug} es premium pero no tiene fecha de vencimiento. Se permite acceso.`);
            }
        }

        // CASO B: Usuario Gratis sin tokens disponibles
        if (user.plan === 'gratis') {
            // Si tokens es null o menor/igual a cero, bloqueamos el acceso
            if (user.tokens === null || user.tokens <= 0) {
                console.log(`🚫 Acceso denegado por falta de tokens para: ${slug}`);
                // Enviamos 402 para disparar la redirección en el dashboard
                return res.status(402).json({
                    active: false,
                    reason: "no_tokens",
                    tokens: user.tokens
                });
            }
        }

        // --- 3. TODO OK (Login manual o sesión persistente) ---
        console.log(`✅ Sesión confirmada para: ${slug} (${user.plan.toUpperCase()})`);
        res.json({ 
            active: true, 
            slug: user.slug, 
            plan: user.plan,
            tokens: user.tokens
        });

    } catch (e) { 
        console.error("🔥 Error crítico en verify-session:", e.message);
        // Enviamos el error para que el frontend no rebote a ciegas
        res.status(500).json({ 
            active: false, 
            error: "internal_server_error",
            msg: e.message 
        }); 
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor NegoSocio en puerto ${PORT}`));
