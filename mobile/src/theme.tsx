import React, { createContext, useContext } from 'react';
import { getLanguage } from './i18n';
import { paletteThemes, type PaletteId } from './themes/palettes';

export type Theme = {
  dark:boolean; black:boolean; bg:string; surface:string; surface2:string; text:string; muted:string;
  border:string; accent:string; accentSoft:string; onAccent:string; bubble:string;
  incoming:string; danger:string; dangerBg:string; chatBg:string; subtle:string; shadow:string;
  glass:string; glassClear:string; glassBorder:string; glassHighlight:string; glassTint:string;
  glassOpaque:string; bgGradient:readonly [string,string,string]; ambientBlue:string; ambientLilac:string;
  accentGradient:readonly [string,string];
};

const basePalette:Record<'light'|'dark'|'black',Theme> = {
  light: {
    dark:false, black:false, bg:'#EDF3FB', surface:'rgba(250,252,255,0.88)', surface2:'rgba(225,233,247,0.62)', text:'#14243D',
    muted:'#5C6E88', border:'rgba(81,109,154,0.17)', accent:'#3568E7', accentSoft:'rgba(70,113,239,0.11)',
    onAccent:'#FFFFFF', bubble:'rgba(218,231,255,0.93)', incoming:'rgba(255,255,255,0.84)', danger:'#B83751', dangerBg:'rgba(255,232,238,0.92)',
    chatBg:'transparent', subtle:'#7B8CA5', shadow:'#294C91',
    glass:'rgba(255,255,255,0.44)', glassClear:'rgba(255,255,255,0.16)', glassBorder:'rgba(255,255,255,0.85)',
    glassHighlight:'rgba(255,255,255,0.82)', glassTint:'rgba(230,239,255,0.15)', glassOpaque:'#F6F8FD',
    bgGradient:['#E7EFFC','#F5F7FD','#E8EEF9'], ambientBlue:'rgba(117,166,255,0.25)', ambientLilac:'rgba(172,151,239,0.17)',
    accentGradient:['#4F7CEC','#315BCF'],
  },
  dark: {
    dark:true, black:false, bg:'#080F1E', surface:'rgba(24,35,57,0.91)', surface2:'rgba(43,59,87,0.67)', text:'#F0F5FF',
    muted:'#ABBCD6', border:'rgba(175,201,247,0.16)', accent:'#9ABEFF', accentSoft:'rgba(115,161,255,0.15)',
    onAccent:'#0A2047', bubble:'rgba(43,70,119,0.92)', incoming:'rgba(30,44,69,0.92)', danger:'#FF9CB0', dangerBg:'rgba(82,34,51,0.88)',
    chatBg:'transparent', subtle:'#8398BA', shadow:'#010511',
    glass:'rgba(19,31,53,0.52)', glassClear:'rgba(26,42,70,0.22)', glassBorder:'rgba(199,219,255,0.23)',
    glassHighlight:'rgba(221,234,255,0.22)', glassTint:'rgba(58,88,141,0.12)', glassOpaque:'#17243A',
    bgGradient:['#0A1529','#10192D','#070E1C'], ambientBlue:'rgba(56,112,224,0.23)', ambientLilac:'rgba(114,88,190,0.13)',
    accentGradient:['#BAD3FF','#85ADFF'],
  },
  // «Чёрная» by Linear's DESIGN.md (ui.gradientdeck.com/styles/linear): Void #08090A page, Carbon
  // #0F1011 cards, Obsidian #161718 raised, Graphite #23252A hairlines, text in the Mist / Fog / Ash
  // greys, white for emphasis, neutral Bone for actions (the acid-lime accent is Linear's own brand).
  black: {
    dark:true, black:true, bg:'#08090A', surface:'rgba(15,16,17,0.96)', surface2:'rgba(22,23,24,0.92)', text:'#E5E5E6',
    muted:'#8A8F98', border:'#23252A', accent:'#E5E5E6', accentSoft:'rgba(255,255,255,0.07)',
    onAccent:'#08090A', bubble:'rgba(31,32,35,0.96)', incoming:'rgba(22,23,24,0.96)', danger:'#FF9CB0', dangerBg:'rgba(69,20,31,0.88)',
    chatBg:'transparent', subtle:'#62666D', shadow:'#000000',
    glass:'rgba(15,16,17,0.62)', glassClear:'rgba(15,16,17,0.26)', glassBorder:'rgba(255,255,255,0.08)',
    glassHighlight:'rgba(255,255,255,0.10)', glassTint:'rgba(8,9,10,0.30)', glassOpaque:'#0F1011',
    bgGradient:['#08090A','#08090A','#08090A'], ambientBlue:'rgba(255,255,255,0.03)', ambientLilac:'rgba(255,255,255,0.02)',
    accentGradient:['#F2F2F2','#C8C8C8'],
  },
};
/** Built-in themes plus the colour palettes (Аметист, Кофе, …). */
export const palette:Record<'light'|'dark'|'black'|PaletteId,Theme> = { ...basePalette, ...paletteThemes };
export const ThemeContext = createContext<Theme>(palette.light);
export const useTheme = () => useContext(ThemeContext);

export const font = { regular: 'System', medium: 'System', bold: 'System' };
export function formatTime(value: string) {
  return new Date(value).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'});
}
function relativeDay(date: Date): 'today' | 'yesterday' | undefined {
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'today';
  const yesterday = new Date(); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'yesterday';
}
export function formatListTime(value: string) {
  const date = new Date(value), day = relativeDay(date);
  if (day === 'today') return formatTime(value);
  if (day === 'yesterday') return 'вчера';
  return date.toLocaleDateString('ru-RU', {day:'numeric',month:'short'});
}
export function formatDay(value: string) {
  const date = new Date(value), day = relativeDay(date);
  if (day === 'today') return 'Сегодня';
  if (day === 'yesterday') return 'Вчера';
  return date.toLocaleDateString('ru-RU', {day:'numeric',month:'long'});
}
export function formatSize(bytes: number) {
  const en = getLanguage() === 'en';
  if (bytes < 1024) return `${bytes} ${en ? 'B' : 'Б'}`;
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(0)} ${en ? 'KB' : 'КБ'}`;
  if (bytes >= 1024 ** 3) return `${(bytes/1024 ** 3).toFixed(1)} ${en ? 'GB' : 'ГБ'}`;
  return `${(bytes/1024/1024).toFixed(1)} ${en ? 'MB' : 'МБ'}`;
}
