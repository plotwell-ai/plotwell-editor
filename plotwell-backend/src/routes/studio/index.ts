import { Router } from 'express';
import developRouter from './develop';
import writeRouter from './write';
import produceRouter from './produce';

const router = Router();

router.use('/', developRouter);
router.use('/', writeRouter);
router.use('/', produceRouter);

export default router;
