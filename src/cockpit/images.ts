import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { LocalGrant } from './policy';
import { idOk } from './policy';
import { safeLocalSource } from './configuration';
import type { AssetRef } from './facade';
import { bounded } from '../util/redact';
export interface ImageProducerReceipt {
  schema:'datapass.image-producer-receipt/1';id:string;sourceSessionId:string|null;nativeReceiptId:string|null;
  producer:string|null;sha256:string;bytes:number;capturedAt:string;
}
export interface ImageIntake extends AssetRef { receiptId:string;nativeReceiptId:string|null;sourceSessionId:string|null;fileHashVerified:true;producerEvidence:'REPORTED'|'UNKNOWN';publication:'NOT_APPROVED'; }
/** Exact host-selected image + scoped receipt; a verified file hash is not verified generation. */
export async function intakeImage(file:string,receipt:ImageProducerReceipt,grant:LocalGrant,stillAuthorized:()=>boolean):Promise<ImageIntake> {
  if(!stillAuthorized() || !receipt || receipt.schema!=='datapass.image-producer-receipt/1' || !idOk(receipt.id) || receipt.sourceSessionId!==null && !grant.sessionKeys.includes(receipt.sourceSessionId) || receipt.nativeReceiptId!==null && !idOk(receipt.nativeReceiptId) || receipt.producer!==null && (!idOk(receipt.producer) || receipt.sourceSessionId===null || receipt.nativeReceiptId===null) || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes<0 || receipt.bytes>10*1024*1024 || !Number.isFinite(Date.parse(receipt.capturedAt)) || !/\.(png|jpe?g|webp|gif)$/i.test(file) || !await safeLocalSource(file))throw new Error('Invalid selected image or producer scope.');
  const st=await fs.stat(file);if(st.size!==receipt.bytes)throw new Error('Image size drift.');
  const sha256=createHash('sha256').update(await fs.readFile(file)).digest('hex');
  if(sha256!==receipt.sha256 || !stillAuthorized())throw new Error('Image hash drift or scope revoked.');
  return {id:'asset:'+receipt.sha256.slice(0,24),sha256,bytes:receipt.bytes,sourceId:receipt.sourceSessionId ?? 'image-receipt:'+receipt.id,state:receipt.producer?'GENERATED_REPORTED':'FILE_OBSERVED',producer:receipt.producer?bounded(receipt.producer,80):null,receiptId:receipt.id,nativeReceiptId:receipt.nativeReceiptId,sourceSessionId:receipt.sourceSessionId,fileHashVerified:true,producerEvidence:receipt.producer?'REPORTED':'UNKNOWN',publication:'NOT_APPROVED'};
}
