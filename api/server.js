import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

// CONFIGURACIÓN DE SEGURIDAD TOTAL (CORS)
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function getSheets(sheetId) {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    return google.sheets({ version: "v4", auth: await auth.getClient() });
}

// 1. LOGIN
app.post("/login", async (req, res) => {
    try {
        const { slug, password } = req.body;
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug.trim()).single();
        if (user && String(user.password) === String(password)) {
            return res.json({ success: true, slug: user.slug });
        }
        res.status(401).json({ success: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. CREAR RESERVA (Guarda la fecha de hoy en Columna D)
app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, fecha, hora, slug } = req.body;
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets(user.sheet_id);

        // Formato para columna C (Día del turno): "25/03 - 15:30"
        const [y, m, d] = fecha.split("-");
        const textoTurno = `${d}/${m} - ${hora}`;

        // FECHA DE HOY REAL (Buenos Aires) para la Columna D
        const ahora = new Date();
        const fechaHoyReal = ahora.toLocaleDateString('es-AR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone: 'America/Argentina/Buenos_Aires'
        });

        await sheets.spreadsheets.values.append({
            spreadsheetId: user.sheet_id,
            range: "A:D", 
            valueInputOption: "RAW",
            requestBody: {
                values: [[name, phone || "N/A", textoTurno, fechaHoyReal]]
            }
        });

        res.json({ success: true });
    } catch (e) {
        console.error("Error en booking:", e);
        res.status(500).json({ error: e.message });
    }
});

// 3. ESTADÍSTICAS (Compara Columna D con Fecha de Hoy)
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', req.params.slug).single();
        if (!user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: user.sheet_id, 
            range: "A:D" 
        });
        
        const rows = response.data.values || [];
        
        // Fecha de hoy exacta en Argentina (DD/MM/YYYY)
        const hoy = new Date().toLocaleDateString('es-AR', { 
            day: '2-digit', 
            month: '2-digit', 
            year: 'numeric',
            timeZone: 'America/Argentina/Buenos_Aires' 
        });

        // Filtramos: r[3] es la Columna D. Usamos trim() para evitar errores por espacios.
        const turnosFiltrados = rows.filter((r, i) => {
            if (i === 0) return false; // Saltamos encabezado
            const fechaEnSheet = r[3] ? r[3].trim() : "";
            return fechaEnSheet === hoy;
        });

        const turnosHoyCount = turnosFiltrados.length;

        console.log(`[Stats] Slug: ${req.params.slug} | Hoy: ${hoy} | Encontrados: ${turnosHoyCount}`);

        res.json({
            stats: {
                turnosHoy: turnosHoyCount,
                ingresosEstimados: turnosHoyCount * (user.precio || 5000),
                businessName: user.business_name || user.slug
            }
        });
    } catch (e) {
        console.error("Error en stats:", e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(process.env.PORT || 10000, () => console.log("Servidor corriendo"));
