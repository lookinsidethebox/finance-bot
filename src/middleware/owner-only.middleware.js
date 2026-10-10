function createOwnerOnlyMiddleware(ownerIds) {
  const allowedIds = new Set(ownerIds);
  return async (context, next) => {
    if (context.chat?.type !== 'private' || !allowedIds.has(String(context.from?.id))) return;
    return next();
  };
}

module.exports = { createOwnerOnlyMiddleware };
