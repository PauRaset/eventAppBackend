const Event = require("../models/Event");
const fs = require("fs");
const sharp = require("sharp");

const getAllEvents = async (req, res) => {
  try {
    const events = await Event.find();
    res.json(events);
  } catch (err) {
    res.status(500).json({ message: "Error al obtener los eventos" });
  }
};

const createEvent = async (req, res) => {
  try {
    console.log("📩 Datos recibidos en el backend:", req.body);
    console.log("📷 Archivo recibido:", req.file);

    let { age, price, categories } = req.body;

    age = age ? parseInt(age) : null;
    price = price ? parseFloat(price) : null;

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

    console.log("✅ Categorías después del parseo:", parsedCategories);
    console.log("✅ Edad:", age, "✅ Precio:", price);

    const newEvent = new Event({
      title: req.body.title,
      description: req.body.description,
      date: req.body.date,
      city: req.body.city,
      street: req.body.street,
      postalCode: req.body.postalCode,
      age,
      dressCode: req.body.dressCode,
      price,
      categories: parsedCategories,
      createdBy: req.user.id,
      image: req.file ? req.file.path : null,
    });

    const savedEvent = await newEvent.save();
    res.status(201).json(savedEvent);
  } catch (error) {
    console.error("❌ Error al guardar el evento:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
};

module.exports = {
  getAllEvents,
  createEvent,
};
