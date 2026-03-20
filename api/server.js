import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

// Configuración de CORS
app.use(cors({ 
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Conexión a Supabase
const supabase = createClient('https://xyhuzdtpjlmtadqamywu.supabase.co', process.env.SUPABASE_KEY);

// Helper para conectar con Google Sheets
async function getSheets(sheetId) {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
}

// --- RUTA DE LOGIN ---
app.post("/admin-login", async (req, res) => {
    const { user, pass } = req.body;
    const cleanUser = user?.trim().toLowerCase();
    
    try {
        const { data: users, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('email', cleanUser);

        if (error) return res.status(500).json({ status: "error", message: "Error de DB" });
        if (!users || users.length === 0) return res.status(401).json({ status: "error", message: "No registrado" });

        const dbUser = users[0];

        if (dbUser.password === pass.trim()) {
            console.log("✅ LOGIN OK para:", dbUser.slug);
            return res.json({ 
                status: "success", 
                slug: dbUser.slug, 
                token: "token_valido_2026" 
            });
        }
        res.status(401).json({ status: "error", message: "Clave incorrecta" });
    } catch (e) {
        res.status(500).json({ error: "Fallo del servidor" });
    }
});

// --- RUTA DE ESTADÍSTICAS (VINCULADA AL SHEETS) ---
app.get("/admin-stats/:slug", async (req, res) => {
    const { slug } = req.params;

    try {
        // 1. Buscamos los datos del usuario en Supabase (su sheet_id y precio)
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('slug', slug)
            .single();

        if (error || !user) return res.status(404).json({ error: "Usuario no encontrado" });

        // 2. Conectamos a su Google Sheet específico
        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "Hoja 1!A:E", // IMPORTANTE: Verifica que la pestaña se llame 'Hoja 1'
        });

        const rows = response.data.values || [];
        const dataRows = rows.slice(1); // Quitamos la fila de encabezados

        // 3. Lógica de Fecha para Argentina (Formato D/M/YYYY como en tu captura)
        const ahora = new Date();
        const opciones = { timeZone: 'America/Argentina/Buenos_Aires' };
        
        const dia = ahora.toLocaleDateString('es-AR', { ...opciones, day: 'numeric' });
        const mes = ahora.toLocaleDateString('es-AR', { ...opciones, month: 'numeric' });
        const anio = ahora.toLocaleDateString('es-AR', { ...opciones, year: 'numeric' });

        const hoyArg = `${dia}/${mes}/${anio}`;
        console.log(`📊 Consultando stats para ${slug}. Fecha buscada: "${hoyArg}"`);

        // 4. Filtrado en Columna D (Índice 3: "semana")
        const turnosDeHoy = dataRows.filter(r => {
            const fechaFila = r[3] ? String(r[3]).trim() : "";
            return fechaFila === hoyArg;
        });

        // 5. Cálculos basados en los datos reales
        const precioUsuario = user.precio || 10000;

        res.json({
            stats: {
                turnosHoy: turnosDeHoy.length,
                turnosMensuales: dataRows.length,
                totalTurnos: dataRows.length,
                ingresosEstimados: turnosDeHoy.length * precioUsuario,
                nombreNegocio: user.business_name || user.slug
            }
        });

    } catch (e) {
        console.error("❌ Error en Stats:", e.message);
        res.status(500).json({ error: "No se pudieron obtener los datos del Sheet" });
    }
});

// Ruta de Salud para Render
app.get("/health", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
