import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const getAuth = () => new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n") : "",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

export async function getFullData() {
    try {
        const auth = getAuth();
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        
        return rows.map(row => ({
            turno: row.get("turno"), 
            phone: row.get("phone"),
            name: row.get("name")
        }));
    } catch (e) {
        console.error("Error leyendo Sheets:", e.message);
        return [];
    }
}

export async function getOccupiedSlots() {
    const data = await getFullData();
    return data.map(d => d.turno).filter(Boolean);
}

export async function saveToSheets(data) {
    try {
        const auth = getAuth();
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];

        // 1. Formateo para la columna "turno" (Lo que ve el barbero: "25/03 - 14:00")
        const [year, month, day] = data.fecha.split("-");
        const turnoFormateado = `${day}/${month} - ${data.hora}`;

        // 2. FECHA Y HORA DE REGISTRO (Cuándo se hizo la reserva)
        const ahora = new Date();
        const opcionesFecha = { 
            timeZone: 'America/Argentina/Buenos_Aires', 
            day: '2-digit', 
            month: '2-digit', 
            year: 'numeric' 
        };
        const opcionesHora = { 
            timeZone: 'America/Argentina/Buenos_Aires', 
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: false 
        };

        const fechaRegistro = ahora.toLocaleDateString('es-AR', opcionesFecha); // "20/03/2026"
        const horaRegistro = ahora.toLocaleTimeString('es-AR', opcionesHora);   // "11:15"
        const registroCompleto = `${fechaRegistro} ${horaRegistro}`;

        // 3. GUARDAR EN EL SHEETS
        // IMPORTANTE: Asegurate que en tu Excel la columna se llame "registro" o "fecha_registro"
        await sheet.addRow({
            name: data.name,
            phone: data.phone,
            turno: turnoFormateado,
            semana: registroCompleto // Seguimos usando la columna 'semana' pero con data útil, o cambiala a 'registro' en el Excel
        });

        return true;
    } catch (e) {
        console.error("Error guardando en Sheets:", e.message);
        return false;
    }
}
