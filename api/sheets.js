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

        // Formateo para la columna "turno" (ej: "19/03 - 15:30")
        const [year, month, day] = data.fecha.split("-");
        const turnoFormateado = `${day}/${month} - ${data.hora}`;

        // --- FECHA LIMPIA PARA ESTADÍSTICAS (Columna semana) ---
        const ahora = new Date();
        const opciones = { timeZone: 'America/Argentina/Buenos_Aires' };
        const d = ahora.toLocaleDateString('es-AR', { ...opciones, day: 'numeric' });
        const m = ahora.toLocaleDateString('es-AR', { ...opciones, month: 'numeric' });
        const a = ahora.toLocaleDateString('es-AR', { ...opciones, year: 'numeric' });
        const fechaHoyLimpia = `${d}/${m}/${a}`; // Resultado: "19/3/2026"

        await sheet.addRow({
            name: data.name,
            phone: data.phone,
            turno: turnoFormateado,
            semana: fechaHoyLimpia 
        });

        return true;
    } catch (e) {
        console.error("Error guardando en Sheets:", e.message);
        return false;
    }
}
