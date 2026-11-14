import { config } from './config';

export const BUCKET = process.env.RTS_BUCKET ?? config.bucket;
export const PARQUET_PREFIX = 'parquet';
