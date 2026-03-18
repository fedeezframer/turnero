import express from "express";
import cors from "cors";
import { saveToSheets, getOccupiedSlots } from "./sheets.js";

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// --- RUTA DE CONSULTA ACTUALIZADA ---
app.get("/check-availability", async (req, res) => {
    try {
        // Obtenemos la fecha que el usuario seleccionó en el calendario (ej: "28")
        const { fecha } = req.query; 
        
        // Traemos los turnos que ya están anotados en el Excel
        const ocupadosDelExcel = await getOccupiedSlots();
        
        // Calculamos la hora exacta en Buenos Aires
        const nowBA = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
        const hoyBA = nowBA.getDate().toString();
        const horaActual = nowBA.getHours();
        const minActual = nowBA.getMinutes();

        // Empezamos con la lista de ocupados que ya teníamos
        let bloqueados = [...ocupadosDelExcel];

        // SI EL DÍA SELECCIONADO ES HOY: Bloqueamos lo que ya pasó
        if (fecha === hoyBA) {
            console.log(`Verificando horarios pasados para hoy (${hoyBA}) a las ${horaActual}:${minActual}`);
            
            // Recorremos desde la hora 0 hasta la hora actual
            for (let h = 0; h <= horaActual; h++) {
                // Si la hora es menor a la actual, bloqueamos los dos turnos (:00 y :30)
                if (h < horaActual) {
                    bloqueados.push(`${fecha} - ${h}:00`);
                    bloqueados.push(`${fecha} - ${h}:30`);
                }
                // Si es la misma hora, bloqueamos según los minutos
                if (h === horaActual) {
                    // El de las :00 se bloquea siempre si ya estamos en esa hora
                    bloqueados.push(`${fecha} - ${h}:00`);
                    // El de las :30 se bloquea si ya pasaron 30 minutos
                    if (minActual >= 30) {
                        bloqueados.push(`${fecha} - ${h}:30`);
                    }
                }
            }
        }

        // Enviamos la lista final (Excel + Horas pasadas)
        res.json({ ocupados: bloqueados });
        
    } catch (e) {
        console.error("Error en check-availability:", e);
        res.status(500).json({ error: "Error de consulta" });
    }
});

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, email, fecha, hora } = req.body;
        const turnoString = `${fecha} - ${hora}`;

        const success = await saveToSheets({ 
            name: name || "Sin nombre", 
            phone: phone || "N/A", 
            email: email || "N/A", 
            turno: turnoString 
        });

        if (success) {
            res.json({ status: "success", message: "Reserva confirmada" });
        } else {
            res.status(500).json({ status: "error", message: "Error en Sheets" });
        }
    } catch (e) {
        res.status(500).json({ status: "error", error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 API en puerto ${PORT} - Filtro BA Activo`));
