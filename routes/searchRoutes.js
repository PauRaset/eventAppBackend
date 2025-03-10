const express = require("express");
const router = express.Router();
const User = require("../models/User"); // Asegúrate de importar tu modelo de usuario

// Ruta para buscar usuarios y clubes
router.get("/api/search", async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) {
            return res
                .status(400)
                .json({ error: "Se requiere un término de búsqueda" });
        }

        // Busca en la base de datos usuarios cuyo nombre de usuario coincida parcialmente
        const users = await User.find({
            username: { $regex: query, $options: "i" },
        }).select("username profilePicture role"); // Selecciona solo los campos necesarios

        res.json(users);
    } catch (error) {
        console.error("Error en la búsqueda:", error);
        res.status(500).json({ error: "Error en el servidor" });
    }
});

module.exports = router;
