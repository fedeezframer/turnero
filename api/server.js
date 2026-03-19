import express from "express";
import cors from "cors";
import { saveToSheets, getFullData } from "./sheets.js";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// --- CONFIGURACIÓN DINÁMICA (Esto es lo que el cliente cambia) ---
let clientConfig = {
    precioServicio: 10000,
    intervalo: "30", // cada cuántos min son los turnos
    inicioHora: 10,
    finHora: 18,
    nombreNegocio: "Mi Negocio",
    colorPrincipal: "#000000"
};

const getBAInfo = () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    return {
        full: now.toISOString().split("T")[0],
        dia: String(now.getDate()).padStart(2, '0'),
        mes: String(now.getMonth() + 1).padStart(2, '0'),
        hora: now.getHours(),
        min: now.getMinutes()
    };
};

// --- RUTAS DE CONFIGURACIÓN ---

app.get("/get-config", (req, res) => res.json(clientConfig));

app.post("/update-config", (req, res) => {
    const { token, newConfig } = req.body;
    if (token !== "token-sesion-admin-2026") return res.status(401).send("No autorizado");
    clientConfig = { ...clientConfig, ...newConfig };
    res.json({ status: "success", config: clientConfig });
});

// --- RUTAS DE CLIENTE (CALENDARIO) ---

app.get("/check-availability", async (req, res) => {
    try {
        const { fecha } = req.query; 
        if (!fecha) return res.status(400).json({ error: "Falta fecha" });
        const allData = await getFullData();
        const ba = getBAInfo();
        let ocupados = allData.map(d => d.turno); 

        if (fecha === ba.full) {
            for (let h = 0; h <= ba.hora; h++) {
                if (h < ba.hora) {
                    ocupados.push(`${ba.dia}/${ba.mes} - ${h}:00`, `${ba.dia}/${ba.mes} - ${h}:30`);
                }
                if (h === ba.hora) {
                    ocupados.push(`${ba.dia}/${ba.mes} - ${h}:00`);
                    if (ba.min >= 30) ocupados.push(`${ba.dia}/${ba.mes} - ${h}:30`);
                }
            }
        }
        res.json({ ocupados, config: clientConfig });
    } catch (e) { res.status(500).json({ error: "Error consulta" }); }
});

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, email, fecha, hora } = req.body;
        const success = await saveToSheets({ name, phone, email, fecha, hora });
        res.json(success ? { status: "success" } : { status: "error" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- RUTAS DE ADMIN (DASHBOARD) ---

app.post("/admin-login", (req, res) => {
    const { user, pass } = req.body;
    const ADMIN_USER = process.env.ADMIN_USER || "admin";
    const ADMIN_PASS = process.env.ADMIN_PASS || "clave123";
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        res.json({ status: "success", token: "token-sesion-admin-2026" });
    } else {
        res.status(401).json({ status: "error", message: "Credenciales inválidas" });
    }
});

app.get("/admin-stats", async (req, res) => {
    try {
        const allData = await getFullData();
        const totalTurnos = allData.length;
        const ba = getBAInfo();
        const hoyStr = `${ba.dia}/${ba.mes}`;
        const turnosHoy = allData.filter(d => d.turno.startsWith(hoyStr)).length;

        res.json({
            stats: {
                totalTurnos,
                turnosHoy,
                ingresosTotales: totalTurnos * clientConfig.precioServicio,
                balanceHoy: turnosHoy * clientConfig.precioServicio
            },
            config: clientConfig,
            turnos: allData.reverse()
        });
    } catch (e) { res.status(500).json({ error: "Error stats" }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Motor Admin Ready`));
