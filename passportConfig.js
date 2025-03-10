const passport = require("passport");
const FacebookStrategy = require("passport-facebook").Strategy;
const User = require("./models/User");

passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_CLIENT_ID,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
      callbackURL: process.env.FACEBOOK_CALLBACK_URL,
      profileFields: ["id", "emails", "name", "picture.type(large)"],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const { id, emails, name, photos } = profile;

        const email = emails?.[0]?.value || `no-email-${id}@facebook.com`;

        let user = await User.findOne({ $or: [{ facebookId: id }, { email }] });

        if (!user) {
          user = new User({
            username: name?.givenName || name?.familyName || "Usuario Facebook",
            email: email,
            facebookId: id,
            profilePicture: photos?.[0]?.value || "",
            role: "spectator", // Rol predeterminado para usuarios de Facebook
          });
          await user.save();
        }

        done(null, user);
      } catch (error) {
        console.error("Error en la estrategia de Facebook:", error);
        done(error, false);
      }
    },
  ),
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id).select("-password");
    done(null, user);
  } catch (error) {
    console.error("Error en la deserialización del usuario:", error);
    done(error, null);
  }
});

module.exports = passport;

/*const passport = require("passport");
const FacebookStrategy = require("passport-facebook").Strategy;
const User = require("./models/User");

// Configurar la estrategia de Facebook
passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_CLIENT_ID,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
      callbackURL: process.env.FACEBOOK_CALLBACK_URL, // URL de producción
      profileFields: ["id", "emails", "name", "picture.type(large)"], // Obtener correo, nombre y foto
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const { id, emails, name, photos } = profile;

        const email = emails?.[0]?.value || `no-email-${id}@facebook.com`;

        let user = await User.findOne({ $or: [{ facebookId: id }, { email }] });

        if (!user) {
          user = new User({
            username: name?.givenName || name?.familyName || "Usuario Facebook",
            email: email,
            facebookId: id,
            profilePicture: photos?.[0]?.value || "",
          });
          await user.save();
        }

        done(null, user);
      } catch (error) {
        console.error("Error en la estrategia de Facebook:", error);
        done(error, false);
      }
    },
  ),
);

// Serialización del usuario
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// Deserialización del usuario
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id).select("-password");
    done(null, user);
  } catch (error) {
    console.error("Error en la deserialización del usuario:", error);
    done(error, null);
  }
});

module.exports = passport;*/
