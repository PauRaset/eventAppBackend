// routes/socialRoutes.js
const express = require('express');
const router = express.Router();

const {
  toggleFollow,
  followUser,
  unfollowUser,
  acceptFollowRequest,
  rejectFollowRequest,
  getFollowers,
  getFollowing,
  getUserStats,
} = require('../controllers/socialController');

const { anyAuth, anyAuthWithId } = require('../middlewares/authMiddleware');

/**
 * Compat notes:
 * - El front intenta primero: POST /api/social/follow/toggle  (body: {targetId})
 * - Fallbacks:                POST /api/users/:id/follow
 *                             DELETE /api/users/:id/follow
 *
 * Exponemos:
 *   1) POST   /follow/toggle                 (body.targetId)              ✅ principal
 *   2) POST   /follow/toggle/:id             (usa req.params.id)          ✅ compat
 *   3) POST   /users/:id/follow              (legacy)                      ✅ compat
 *   4) DELETE /users/:id/follow              (legacy)                      ✅ compat
 *   5) GET    /users/:id/followers
 *   6) GET    /users/:id/following
 *   7) GET    /users/:id/stats               (anyAuth para isFollowing)
 */

// ---- Follow / Unfollow (toggle) ----
router.post('/follow/toggle', anyAuthWithId, toggleFollow);

// Variante con parámetro por URL para compatibilidad
router.post('/follow/toggle/:id', anyAuthWithId, (req, res, next) => {
  req.body = req.body || {};
  if (!req.body.targetId && req.params.id) {
    req.body.targetId = req.params.id;
  }
  return toggleFollow(req, res, next);
});

// ---- Legacy explicit endpoints ----
router.post('/users/:id/follow', anyAuthWithId, followUser);
router.delete('/users/:id/follow', anyAuthWithId, unfollowUser);

// ---- Follow Requests (private profiles) ----
router.post('/follow/requests/:id/accept', anyAuthWithId, acceptFollowRequest);
router.post('/follow/requests/:id/reject', anyAuthWithId, rejectFollowRequest);

// ---- Lists ----
router.get('/users/:id/followers', getFollowers);
router.get('/users/:id/following', getFollowing);

// ---- Stats ----
router.get('/users/:id/stats', anyAuth, getUserStats);

// --- Preflight CORS ---
router.options('/follow/toggle', (_req, res) => res.sendStatus(200));
router.options('/follow/toggle/:id', (_req, res) => res.sendStatus(200));
router.options('/users/:id/follow', (_req, res) => res.sendStatus(200));

router.options('/follow/requests/:id/accept', (_req, res) => res.sendStatus(200));
router.options('/follow/requests/:id/reject', (_req, res) => res.sendStatus(200));

module.exports = router;
