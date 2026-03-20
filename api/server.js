import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

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

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, fecha, hora, slug } = req.body;
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets(user.sheet_id);
        const [y, m, d] = fecha.split("-");
        const textoTurno = `${d}/${m} - ${hora}`;
        const ahora = new Date();
        const fechaHoyReal = ahora.toLocaleDateString('es-AR', {
            day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires'
        });

        await sheets.spreadsheets.values.append({
            spreadsheetId: user.sheet_id,
            range: "A:D", 
            valueInputOption: "RAW",
            requestBody: { values: [[name, phone || "N/A", textoTurno, fechaHoyReal]] }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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
        const ahora = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
        const mesHoy = String(ahora.getMonth() + 1).padStart(2, '0');
        const diaHoyStr = String(ahora.getDate()).padStart(2, '0') + "/" + mesHoy;

        let turnosHoy = 0;
        let turnosMes = 0;
        let conteoPorDia = {}; // Para el gráfico

        rows.forEach((r, i) => {
            if (i === 0 || !r[2]) return;
            const fechaParte = r[2].trim().split(" - ")[0]; // "DD/MM"
            const [dia, mes] = fechaParte.split("/");

            if (mes === mesHoy) {
                turnosMes++;
                // Agrupamos para el gráfico
                conteoPorDia[fechaParte] = (conteoPorDia[fechaParte] || 0) + 1;
            }
            if (fechaParte === diaHoyStr) turnosHoy++;
        });

        // Convertimos el conteo a un array ordenado para el componente de Framer
        const chartData = Object.keys(conteoPorDia)
            .map(fecha => ({ fecha, turnos: conteoPorDia[fecha] }))
            .sort((a, b) => a.fecha.localeCompare(b.fecha))
            .slice(-7); // Mostramos solo los últimos 7 días con actividad

        const ingresosMensuales = turnosMes * (user.precio || 5000);

        res.json({
            stats: {
                turnosHoy,
                turnosMes,
                ingresosEstimados: ingresosMensuales,
                promedioDiario: Math.round(ingresosMensuales / ahora.getDate()),
                chartData, // <--- DATOS PARA EL GRÁFICO
                businessName: user.business_name || user.slug
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(process.env.PORT || 10000, () => console.log("Servidor corriendo"));
