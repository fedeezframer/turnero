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

// --- FUNCIÓN DE LIMPIEZA MÁGICA ---
const getCleanSlug = (rawSlug) => {
    if (!rawSlug) return "";
    return rawSlug
        .replace("reserva-user-", "")
        .replace("check-availability-", "")
        .replace("/", "")
        .trim();
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

// 1. OBTENER OCUPADOS
app.get("/get-occupied", async (req, res) => {
    try {
        const slug = getCleanSlug(req.query.slug);
        if (!slug) return res.status(400).json({ error: "Falta el slug" });

        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "C:C", 
        });

        const rows = response.data.values || [];
        const formatoCorrecto = /^\d{2}\/\d{2} - \d{2}:\d{2}$/;

        const ocupados = rows
            .flat()
            .map(val => val ? val.trim() : "")
            .filter(val => formatoCorrecto.test(val));

        res.json({ success: true, ocupados });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. CREAR RESERVA
app.post("/create-booking", async (req, res) => {
    try {
        let { name, phone, fecha, hora, slug: rawSlug } = req.body;
        const slug = getCleanSlug(rawSlug);

        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets(user.sheet_id);
        
        const [y, m, d] = fecha.split("-");
        const diaNorm = String(d).padStart(2, '0');
        const mesNorm = String(m).padStart(2, '0');
        const [h, min] = hora.split(":");
        const horaNorm = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

        const textoTurno = `${diaNorm}/${mesNorm} - ${horaNorm}`;
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

// 3. LOGIN
app.post("/login", async (req, res) => {
    try {
        const slug = getCleanSlug(req.body.slug);
        const { password } = req.body;
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (user && String(user.password) === String(password)) {
            return res.json({ success: true, slug: user.slug });
        }
        res.status(401).json({ success: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. ADMIN STATS (Lógica de crecimiento y tiempo real)
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const slug = getCleanSlug(req.params.slug);
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: user.sheet_id, range: "A:D" });
        const rows = response.data.values || [];

        // --- LÓGICA DE TIEMPO (ARGENTINA) ---
        const ahora = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
        const mesActual = ahora.getMonth() + 1;
        const mesAnterior = mesActual === 1 ? 12 : mesActual - 1;
        const diaHoyNum = ahora.getDate();
        const añoActual = ahora.getFullYear();

        const hoyString = `${String(diaHoyNum).padStart(2, '0')}/${String(mesActual).padStart(2, '0')}`;
        
        // Ayer (para el crecimiento diario)
        const ayerDate = new Date(ahora);
        ayerDate.setDate(ahora.getDate() - 1);
        const ayerString = `${String(ayerDate.getDate()).padStart(2, '0')}/${String(ayerDate.getMonth() + 1).padStart(2, '0')}`;

        let turnosHoy = 0;
        let turnosAyer = 0;
        let turnosMesActual = 0;
        let turnosMesAnterior = 0;
        let turnosLista = []; // Para el componente de horas trabajadas en Framer
        let semanas = { "Sem 1": 0, "Sem 2": 0, "Sem 3": 0, "Sem 4": 0 };

        rows.forEach((r, i) => {
            if (i === 0 || !r[2]) return;
            const valorTurno = r[2].trim(); 
            const partesSeparadas = valorTurno.split(" - ");
            const fechaParte = partesSeparadas[0]; // "21/03"
            const horaParte = partesSeparadas[1];  // "10:30"
            const partesFecha = fechaParte.split("/");
            
            if (partesFecha.length >= 2) {
                const dia = parseInt(partesFecha[0]);
                const mes = parseInt(partesFecha[1]);

                // Filtro para Mes Actual
                if (mes === mesActual) {
                    turnosMesActual++;
                    
                    // Llenamos las semanas para el gráfico
                    if (dia <= 7) semanas["Sem 1"]++;
                    else if (dia <= 14) semanas["Sem 2"]++;
                    else if (dia <= 21) semanas["Sem 3"]++;
                    else semanas["Sem 4"]++;

                    // Agregamos a la lista para el componente de horas
                    turnosLista.push({
                        fecha: `${añoActual}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
                        hora: horaParte
                    });
                } 
                
                // Filtro para Mes Anterior (Comparativa)
                if (mes === mesAnterior) {
                    turnosMesAnterior++;
                }

                // Filtro para Hoy y Ayer
                if (fechaParte === hoyString) turnosHoy++;
                if (fechaParte === ayerString) turnosAyer++;
            }
        });

        // --- CÁLCULO DE CRECIMIENTO ---
        const calcularPorcentaje = (act, ant) => {
            if (ant === 0) return act > 0 ? 100 : 0;
            return Math.round(((act - ant) / ant) * 100);
        };

        const precioUser = user.precio || 5000;
        const ingresosMesActual = turnosMesActual * precioUser;
        const ingresosMesAnterior = turnosMesAnterior * precioUser;

        res.json({
            stats: {
                turnosHoy,
                turnosMes: turnosMesActual,
                ingresosEstimados: ingresosMesActual,
                promedioDiario: diaHoyNum > 0 ? Math.round(ingresosMesActual / diaHoyNum) : 0,
                chartData: Object.keys(semanas).map(key => ({ label: key, turnos: semanas[key] })),
                businessName: user.business_name || user.slug,
                turnosLista: turnosLista, // Enviamos la lista cruda para que Framer calcule horas pasadas
                
                // Objeto para el GrowthBadge
                crecimiento: {
                    turnos: {
                        day: calcularPorcentaje(turnosHoy, turnosAyer),
                        month: calcularPorcentaje(turnosMesActual, turnosMesAnterior)
                    },
                    ingresos: {
                        day: calcularPorcentaje(turnosHoy * precioUser, turnosAyer * precioUser),
                        month: calcularPorcentaje(ingresosMesActual, ingresosMesAnterior)
                    }
                }
            }
        });
    } catch (e) { 
        console.error("Error en stats:", e);
        res.status(500).json({ error: e.message }); 
    }
});

app.listen(process.env.PORT || 10000, () => console.log("Servidor corriendo"));
