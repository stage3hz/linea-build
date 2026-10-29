import type { LineaPhotoBridge } from '../../modules/linea-photo';

export function getPhotoBridge():LineaPhotoBridge {
  throw new Error('Редактор фото доступен в нативном приложении Android/iPhone.');
}
