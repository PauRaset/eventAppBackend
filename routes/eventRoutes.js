const express = require("express");
const multer = require("multer");
const path = require("path");
const sharp = require("sharp");
const fs = require("fs");
const router = express.Router();
const Event = require("../models/Event");
const authenticateToken = require("../middlewares/authMiddleware"); 

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage });

router.post(
  "/",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    try {
      const {
        title,
        description,
        date,
        city,
        street,
        postalCode,
        categories, 
        age,
        dressCode,
        price,
      } = req.body;
      let image = null;

      if (!req.user || !req.user.id) {
        return res.status(401).json({ message: "Usuario no autenticado" });
      }

      const userId = req.user.id;

      if (req.file) {
        const processedImagePath = `uploads/resized-${Date.now()}-${req.file.originalname}`;
        await sharp(req.file.path)
          .resize(800, 450, { fit: "cover" })
          .toFile(processedImagePath);

        image = processedImagePath;
        fs.unlinkSync(req.file.path);
      }

      let parsedCategories = categories;
      if (typeof categories === "string") {
        try {
          parsedCategories = JSON.parse(categories);
          if (!Array.isArray(parsedCategories)) {
            parsedCategories = [];
          }
        } catch (err) {
          console.error("⚠️ Error al parsear categorías:", err);
          return res
            .status(400)
            .json({ message: "Formato de categorías inválido" });
        }
      }

      const newEvent = new Event({
        title,
        description,
        date,
        city,
        street,
        postalCode,
        image,
        categories: parsedCategories, 
        age,
        dressCode,
        price,
        createdBy: userId,
      });

      const savedEvent = await newEvent.save();
      res.status(201).json(savedEvent);
    } catch (error) {
      console.error("Error al guardar el evento:", error);
      res
        .status(500)
        .json({ message: "Error al guardar el evento", error: error.message });
    }
  },
);

router.get("/", async (req, res) => {
  try {
    const events = await Event.find().populate(
      "createdBy",
      "username email profilePicture",
    );

    const formattedEvents = events.map((event) => ({
      ...event.toObject(),
      categories: Array.isArray(event.categories)
        ? event.categories
        : typeof event.categories === "string"
          ? JSON.parse(event.categories)
          : [],
    }));

    res.json(formattedEvents);
  } catch (error) {
    console.error("Error al obtener los eventos:", error);
    res.status(500).json({ message: "Error al obtener los eventos", error });
  }
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const event = await Event.findById(id).populate(
      "createdBy",
      "username email profilePicture",
    );
    if (!event) {
      return res.status(404).json({ message: "Evento no encontrado" });
    }

    const formattedEvent = {
      ...event.toObject(),
      categories: Array.isArray(event.categories)
        ? event.categories.map((cat) =>
            typeof cat === "string" ? cat : String(cat),
          )
        : [],
    };

    const userId = req.user ? req.user.id : null;
    const isOwner = userId && event.createdBy._id.toString() === userId;

    res.json({ ...formattedEvent, isOwner });
  } catch (error) {
    console.error("Error al obtener el evento:", error);
    res.status(500).json({ message: "Error al obtener el evento", error });
  }
});

router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id); 

    if (!event) {
      return res.status(404).json({ message: "Evento no encontrado" });
    }

    if (event.createdBy.toString() !== req.user.id) {
      return res
        .status(403)
        .json({ message: "No tienes permiso para eliminar este evento" });
    }

    await Event.findByIdAndDelete(req.params.id);
    res.json({ message: "Evento eliminado correctamente" });
  } catch (error) {
    console.error("Error al eliminar el evento:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
});

router.post("/:id/attend", authenticateToken, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Evento no encontrado" });
    }

    const userId = req.user.id;

    const userIndex = event.attendees.indexOf(userId);
    if (userIndex !== -1) {
      event.attendees.splice(userIndex, 1);
    } else {
      event.attendees.push(userId);
    }

    await event.save();
    res.json(event);
  } catch (error) {
    console.error("Error al alternar asistencia:", error);
    res.status(500).json({ message: "Error interno del servidor", error });
  }
});

module.exports = router;
