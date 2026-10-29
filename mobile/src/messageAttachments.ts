import type { Attachment } from './types';
export const MAX_DRAFT_ATTACHMENTS=10;

export function appendAttachments(current:Attachment[],incoming:Attachment[]):Attachment[] {
  const unique=new Map(current.map(file=>[file.id,file]));
  for(const file of incoming)if(!unique.has(file.id))unique.set(file.id,file);
  if(unique.size>MAX_DRAFT_ATTACHMENTS)throw new Error(`В одном выборе можно добавить не больше ${MAX_DRAFT_ATTACHMENTS} вложений.`);
  return [...unique.values()];
}

export function messageAttachmentBatch(text:string,attachments:Attachment[]):{text:string;attachment:Attachment|null}[] {
  const caption=text.trim(),files=appendAttachments([],attachments);
  if(!files.length)return caption?[{text:caption,attachment:null}]:[];
  return files.map((attachment,index)=>({text:index===0?caption:'',attachment}));
}
