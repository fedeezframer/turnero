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

// 2. CREAR RESERVA
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

// 3. ESTADÍSTICAS Y GRÁFICO POR SEMANAS
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', req.params.slug).single();
        if (!user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: user.sheet_id, 
            range: "A:C" // Leemos hasta la C que tiene el turno
        });
        
        const rows = response.data.values || [];
        const ahora = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
        
        const diaHoyNum = ahora.getDate();
        const mesHoyNum = ahora.getMonth() + 1;
        const mesHoyStr = String(mesHoyNum).padStart(2, '0');
        const hoyString = `${String(diaHoyNum).padStart(2, '0')}/${mesHoyStr}`;

        let turnosHoy = 0;
        let turnosMes = 0;
        
        // Estructura para el gráfico semanal
        let semanas = { "Sem 1": 0, "Sem 2": 0, "Sem 3": 0, "Sem 4": 0 };

        rows.forEach((r, i) => {
            if (i === 0 || !r[2]) return;
            
            const valorTurno = r[2].trim();
            const fechaParte = valorTurno.split(" - ")[0]; // "DD/MM"
            const [dia, mes] = fechaParte.split("/").map(Number);

            // Filtramos solo los del mes actual
            if (mes === mesHoyNum) {
                turnosMes++;
                
                // Lógica de agrupación semanal
                if (dia <= 7) semanas["Sem 1"]++;
                else if (dia <= 14) semanas["Sem 2"]++;
                else if (dia <= 21) semanas["Sem 3"]++;
                else semanas["Sem 4"]++;
            }

            if (fechaParte === hoyString) {
                turnosHoy++;
            }
        });

        // Formateamos los datos para el componente de Framer
        const chartData = Object.keys(semanas).map(key => ({
            label: key,
            turnos: semanas[key]
        }));

        const ingresosMensuales = turnosMes * (user.precio || 5000);
        const promedioDiario = Math.round(ingresosMensuales / diaHoyNum);

        console.log(`[Stats] ${req.params.slug} | Hoy: ${turnosHoy} | Mes: ${turnosMes}`);

        res.json({
            stats: {
                turnosHoy,
                turnosMes,
                ingresosEstimados: ingresosMensuales,
                promedioDiario,
                chartData,
                businessName: user.business_name || user.slug
            }
        });
    } catch (e) {
        console.error("Error en stats:", e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(process.env.PORT || 10000, () => console.log("Servidor corriendo"));
