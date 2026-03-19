import express from "express";
import cors from "cors";
import { saveToSheets, getFullData } from "./sheets.js";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// Helper para obtener la fecha de Buenos Aires formateada
const getBAInfo = () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    return {
        full: now.toISOString().split("T")[0], // YYYY-MM-DD
        dia: String(now.getDate()).padStart(2, '0'),
        mes: String(now.getMonth() + 1).padStart(2, '0'),
        hora: now.getHours(),
        min: now.getMinutes(),
        raw: now
    };
};

app.get("/check-availability", async (req, res) => {
    try {
        const { fecha } = req.query; // Viene como YYYY-MM-DD
        if (!fecha) return res.status(400).json({ error: "Falta fecha" });

        const allData = await getFullData();
        const ba = getBAInfo();

        // 1. Obtener turnos ocupados desde el Sheets
        let ocupados = allData.map(d => d.turno); 

        // 2. Si la consulta es para HOY, bloquear horas pasadas
        if (fecha === ba.full) {
            // Recorremos desde las 00:00 hasta la hora actual
            for (let h = 0; h <= ba.hora; h++) {
                const horaString = `${h}:00`;
                const horaMediaString = `${h}:30`;

                // Bloqueamos horas anteriores por completo
                if (h < ba.hora) {
                    ocupados.push(`${ba.dia}/${ba.mes} - ${horaString}`);
                    ocupados.push(`${ba.dia}/${ba.mes} - ${horaMediaString}`);
                }
                // Si es la hora actual, bloqueamos según los minutos
                if (h === ba.hora) {
                    ocupados.push(`${ba.dia}/${ba.mes} - ${horaString}`);
                    if (ba.min >= 30) {
                        ocupados.push(`${ba.dia}/${ba.mes} - ${horaMediaString}`);
                    }
                }
            }
        }

        res.json({ ocupados });
    } catch (e) {
        console.error("Error availability:", e);
        res.status(500).json({ error: "Error de consulta" });
    }
});

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, email, fecha, hora } = req.body; 
        // fecha: "2026-03-19", hora: "15:30"
        
        const rows = await getFullData();
        const ba = getBAInfo();

        // VALIDACIÓN: ¿Ya tiene un turno para esta fecha o a futuro?
        const tieneTurnoActivo = rows.some(row => {
            if (!row.turno || !row.phone) return false;
            if (row.phone !== phone) return false;

            // Extraemos fecha del turno "19/03 - 15:30" -> "03-19"
            const [fechaTurno] = row.turno.split(" - ");
            const [d, m] = fechaTurno.split("/");
            
            // Comparamos mes y día (simplificado para los 2 meses de ventana)
            const valorTurno = parseInt(m) * 100 + parseInt(d);
            const valorHoy = parseInt(ba.mes) * 100 + parseInt(ba.dia);

            return valorTurno >= valorHoy;
        });

        if (tieneTurnoActivo) {
            return res.status(400).json({ 
                status: "error", 
                message: "Ya tenés un turno agendado para los próximos días." 
            });
        }

        // Guardamos pasando los campos por separado para que sheets.js los procese
        const success = await saveToSheets({ name, phone, email, fecha, hora });
        
        res.json(success ? { status: "success" } : { status: "error" });
    } catch (e) {
        console.error("Error booking:", e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 API activa y actualizada`)); 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 API activa`));
