import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

app.use(cors({ 
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const supabase = createClient('https://xyhuzdtpjlmtadqamywu.supabase.co', process.env.SUPABASE_KEY);

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
            console.log("✅ LOGIN OK:", dbUser.slug);
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

app.get("/admin-stats/:slug", async (req, res) => {
    const { slug } = req.params;

    try {
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('slug', slug)
            .single();

        if (error || !user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "Hoja 1!A:E", 
        });

        const rows = response.data.values || [];
        const dataRows = rows.slice(1); 

        // --- LÓGICA DE FECHA ARGENTINA ---
        // Obtenemos la fecha en formato D/M/YYYY (ej: 19/3/2026)
        const hoyArgentina = new Intl.DateTimeFormat('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            day: 'numeric',
            month: 'numeric',
            year: 'numeric'
        }).format(new Date());

        console.log(`📊 Stats para ${slug}. Fecha hoy: ${hoyArgentina}`);

        // FILTRAMOS EN COLUMNA D (Índice 3)
        const turnosDeHoy = dataRows.filter(r => {
            const fechaFila = r[3] ? r[3].trim() : "";
            // Comparamos el texto exacto (ej: "19/3/2026" === "19/3/2026")
            return fechaFila === hoyArgentina;
        });

        res.json({
            stats: {
                turnosHoy: turnosDeHoy.length,
                turnosMensuales: dataRows.length,
                totalTurnos: dataRows.length,
                ingresosEstimados: turnosDeHoy.length * (user.precio || 10000),
                nombreNegocio: user.business_name || user.slug
            }
        });

    } catch (e) {
        console.error("❌ Error en Stats:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get("/health", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Port ${PORT}`));
