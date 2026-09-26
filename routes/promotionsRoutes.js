// routes/promotionsRoutes.js
const express = require('express');
const router = express.Router();

const promotionsController = require('../controllers/promotionsController');
const requireFirebase = require('../middlewares/requireFirebase');
const { anyAuthWithId } = require('../middlewares/authMiddleware');

// ===========================
// USER (app)
// ===========================

// Lista de promos del usuario (para pintar la pantalla principal)
// GET /api/promotions/my
router.get('/my', requireFirebase, promotionsController.getMyPromotions);

// Devuelve niveles (10) + progreso del usuario para un club
// GET /api/promotions/:clubId/levels

// Canjear la recompensa del nivel actual completado
// POST /api/promotions/:clubId/redeem
router.post('/:clubId/redeem', requireFirebase, promotionsController.redeemCurrentLevelReward);
router.get('/:clubId/levels', requireFirebase, promotionsController.getClubLevelsForUser);

// Crear un claim (subir prueba: foto/qr/text) para una misión
// POST /api/promotions/:clubId/claims
router.post('/:clubId/claims', requireFirebase, promotionsController.createClaim);

// Cancelar un claim propio (opcional)
// POST /api/promotions/claims/:claimId/cancel
router.post('/claims/:claimId/cancel', requireFirebase, promotionsController.cancelClaim);

// ===========================
// CLUB (panel)
// ===========================

// Listar claims pendientes para un club (opcional pero MUY útil para el panel)
// GET /api/promotions/clubs/:clubId/claims?status=pending
router.get('/clubs/:clubId/claims', anyAuthWithId, promotionsController.listClubClaims);

// Aprobar claim (club valida)
// POST /api/promotions/claims/:claimId/approve
router.post('/claims/:claimId/approve', anyAuthWithId, promotionsController.approveClaim);

// Rechazar claim (club valida)
// POST /api/promotions/claims/:claimId/reject
router.post('/claims/:claimId/reject', anyAuthWithId, promotionsController.rejectClaim);

// Obtener configuración editable de promociones del club
// GET /api/promotions/clubs/:clubId/levels
router.get('/clubs/:clubId/levels', anyAuthWithId, promotionsController.getClubPromotionConfig);

// Guardar niveles/premios/misiones del club
// PUT /api/promotions/clubs/:clubId/levels
router.put('/clubs/:clubId/levels', anyAuthWithId, promotionsController.upsertClubLevelOverrides);

module.exports = router;
