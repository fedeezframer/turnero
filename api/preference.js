import { MercadoPagoConfig, Preference } from "mercadopago";

export async function createPreference(req, res) {
    try {
        const { nombre, telefono, fecha, hora, slug, price } = req.body;

        const client = new MercadoPagoConfig({ 
            accessToken: process.env.MP_ACCESS_TOKEN 
        });
        const preference = new Preference(client);

        const response = await preference.create({
            body: {
                items: [
                    {
                        title: `Reserva: ${fecha} a las ${hora}hs`,
                        unit_price: Number(price || 5000), // Precio por defecto si no viene uno
                        quantity: 1,
                        currency_id: "ARS"
                    }
                ],
                // Guardamos todo en metadata para que el Webhook sepa qué se pagó
                metadata: {
                    nombre,
                    telefono,
                    fecha,
                    hora,
                    slug
                },
                back_urls: {
                    success: "https://dreamwebtesttemplate.framer.website/success",
                    failure: "https://dreamwebtesttemplate.framer.website/error",
                    pending: "https://dreamwebtesttemplate.framer.website/error"
                },
                auto_return: "approved",
            },
        });

        // Devolvemos el link de pago al frontend
        res.json({ payment_url: response.init_point });
    } catch (error) {
        console.error("Error al crear preferencia:", error);
        res.status(500).json({ error: error.message });
    }
}
