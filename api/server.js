import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const getCleanSlug = (rawSlug) => {
    if (!rawSlug) return "";
    return rawSlug.replace("reserva-user-", "").replace("check-availability-", "").replace("/", "").trim();
};

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

// 1. OBTENER OCUPADOS, 2. CREAR RESERVA, 3. LOGIN (Se mantienen igual)
app.get("/get-occupied", async (req, res) => {
    try {
        const slug = getCleanSlug(req.query.slug);
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: user.sheet_id, range: "C:C" });
        const rows = response.data.values || [];
        const formato = /^\d{2}\/\d{2} - \d{2}:\d{2}$/;
        const ocupados = rows.flat().map(v => v ? v.trim() : "").filter(v => formato.test(v));
        res.json({ success: true, ocupados });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/create-booking", async (req, res) => {
    try {
        let { name, phone, fecha, hora, slug: rawSlug } = req.body;
        const slug = getCleanSlug(rawSlug);
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        const [y, m, d] = fecha.split("-");
        const textoTurno = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')} - ${hora}`;
        const fechaHoy = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const sheets = await getSheets(user.sheet_id);
        await sheets.spreadsheets.values.append({
            spreadsheetId: user.sheet_id, range: "A:D", valueInputOption: "RAW",
            requestBody: { values: [[name, phone || "N/A", textoTurno, fechaHoy]] }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/login", async (req, res) => {
    try {
        const slug = getCleanSlug(req.body.slug);
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (user && String(user.password) === String(req.body.password)) return res.json({ success: true, slug: user.slug });
        res.status(401).json({ success: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. ADMIN STATS - LÓGICA DE COMPARACIÓN DD/MM Y CRECIMIENTO REAL
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const slug = getCleanSlug(req.params.slug);
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: user.sheet_id, range: "A:D" });
        const rows = response.data.values || [];

        // Tiempo real Argentina
        const ahora = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
        const mesActual = ahora.getMonth() + 1;
        const mesAnterior = mesActual === 1 ? 12 : mesActual - 1;
        const diaHoy = ahora.getDate();
        const añoAct = ahora.getFullYear();

        let tHoy = 0, tAyer = 0, tMesAct = 0, tMesAnt = 0;
        let turnosLista = [];
        let semanas = { "Sem 1": 0, "Sem 2": 0, "Sem 3": 0, "Sem 4": 0 };

        rows.forEach((r, i) => {
            if (i === 0 || !r[2]) return;
            const valorTurno = r[2].trim(); // "21/03 - 10:30"
            const [fechaParte, horaParte] = valorTurno.split(" - ");
            const [d, m] = fechaParte.split("/").map(Number);

            // Comparación Mes Actual
            if (m === mesActual) {
                tMesAct++;
                if (d === diaHoy) tHoy++;
                if (d === (diaHoy - 1)) tAyer++;
                
                // Gráfico y Lista
                if (d <= 7) semanas["Sem 1"]++;
                else if (d <= 14) semanas["Sem 2"]++;
                else if (d <= 21) semanas["Sem 3"]++;
                else semanas["Sem 4"]++;

                turnosLista.push({
                    fecha: `${añoAct}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
                    hora: horaParte
                });
            } 
            // Comparación Mes Anterior (Histórico)
            else if (m === mesAnterior) {
                tMesAnt++;
            }
        });

        const precio = user.precio || 5000;
        const ingAct = tMesAct * precio;
        const ingAnt = tMesAnt * precio;

        // Función de porcentaje que evita el 100% si el mes pasado fue 0
        const calcCrecimiento = (act, ant) => {
            if (ant === 0) return 0; 
            return Math.round(((act - ant) / ant) * 100);
        };

        res.json({
            stats: {
                turnosHoy: tHoy,
                turnosMes: tMesAct,
                ingresosEstimados: ingAct,
                promedioDiario: diaHoy > 0 ? Math.round(ingAct / diaHoy) : 0,
                chartData: Object.keys(semanas).map(k => ({ label: k, turnos: semanas[k] })),
                businessName: user.business_name || user.slug,
                turnosLista,
                crecimiento: {
                    turnos: {
                        day: calcCrecimiento(tHoy, tAyer),
                        month: calcCrecimiento(tMesAct, tMesAnt)
                    },
                    ingresos: {
                        month: calcCrecimiento(ingAct, ingAnt)
                    }
                }
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 10000, () => console.log("Servidor en línea"));
