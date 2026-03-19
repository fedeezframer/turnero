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
        
        // Retornamos los datos limpios
        return rows.map(row => ({
            turno: row.get("turno"), // Formato guardado: "19/03 - 15:30"
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
    // Filtramos solo los turnos que tengan valor
    return data.map(d => d.turno).filter(Boolean);
}

export async function saveToSheets(data) {
    try {
        const auth = getAuth();
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];

        // LÓGICA DE FORMATEO:
        // data.fecha viene como "2026-03-19"
        // data.hora viene como "15:30"
        
        const [year, month, day] = data.fecha.split("-");
        const turnoFormateado = `${day}/${month} - ${data.hora}`;

        await sheet.addRow({
            name: data.name,
            phone: data.phone,
            turno: turnoFormateado, // Guardamos "19/03 - 15:30"
            semana: new Date().toLocaleDateString("es-AR") // Fecha de creación del registro
        });

        return true;
    } catch (e) {
        console.error("Error guardando en Sheets:", e.message);
        return false;
    }
}
