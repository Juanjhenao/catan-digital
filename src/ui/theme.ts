import type { PlayerColor, Resource, Terrain } from '../engine/index.js';

/**
 * Paleta del juego. Todo el color vive aqui para que el estilo se pueda
 * retocar sin tocar el codigo de dibujo.
 */

export interface TerrainPalette {
  /** Color de fondo de la casilla. */
  base: string;
  /** Segundo tono para el degradado del relieve. */
  shade: string;
  /** Color del detalle ilustrado (arboles, espigas, rocas...). */
  detail: string;
  detailDark: string;
  label: string;
}

export const TERRAIN_PALETTE: Record<Terrain, TerrainPalette> = {
  forest: {
    base: '#2f6b3f',
    shade: '#245231',
    detail: '#1d4a2b',
    detailDark: '#13331d',
    label: 'Bosque',
  },
  hills: {
    base: '#b4643a',
    shade: '#8f4a29',
    detail: '#8a4526',
    detailDark: '#5f2d18',
    label: 'Colinas',
  },
  pasture: {
    base: '#7fb04b',
    shade: '#659139',
    detail: '#f2f4ea',
    detailDark: '#4d7029',
    label: 'Pastos',
  },
  fields: {
    base: '#e3b23c',
    shade: '#c9942a',
    detail: '#a9761c',
    detailDark: '#7d5512',
    label: 'Campos',
  },
  mountains: {
    base: '#8892a3',
    shade: '#6c7788',
    detail: '#59636f',
    detailDark: '#3c454f',
    label: 'Montanas',
  },
  desert: {
    base: '#e0cd9a',
    shade: '#c9b37c',
    detail: '#b79c65',
    detailDark: '#8d764a',
    label: 'Desierto',
  },
};

export const RESOURCE_COLOR: Record<Resource, string> = {
  lumber: '#2f6b3f',
  brick: '#b4643a',
  wool: '#7fb04b',
  grain: '#e3b23c',
  ore: '#8892a3',
};

export const RESOURCE_LABEL: Record<Resource, string> = {
  lumber: 'Madera',
  brick: 'Arcilla',
  wool: 'Lana',
  grain: 'Trigo',
  ore: 'Mineral',
};

export interface PlayerPalette {
  main: string;
  dark: string;
  light: string;
  ink: string;
  label: string;
}

export const PLAYER_PALETTE: Record<PlayerColor, PlayerPalette> = {
  red: { main: '#d13b3b', dark: '#8e2323', light: '#f07a7a', ink: '#fff', label: 'Rojo' },
  blue: { main: '#3b74d1', dark: '#23498e', light: '#84aaf0', ink: '#fff', label: 'Azul' },
  white: { main: '#eceff3', dark: '#a7adb8', light: '#ffffff', ink: '#22262d', label: 'Blanco' },
  orange: { main: '#e08b2a', dark: '#a35f13', light: '#f5bb70', ink: '#fff', label: 'Naranja' },
  green: { main: '#3aa76d', dark: '#217048', light: '#7fd3a6', ink: '#fff', label: 'Verde' },
  brown: { main: '#8b5e3c', dark: '#5e3d26', light: '#c09372', ink: '#fff', label: 'Marron' },
};

export const SEA = {
  deep: '#1b3d5c',
  mid: '#255072',
  foam: 'rgba(255,255,255,0.16)',
};

export const TOKEN = {
  face: '#f3e7cb',
  edge: '#c9b48b',
  ink: '#3a3025',
  red: '#b3312a',
};

/** Anillo de mar que rodea la isla y la mesa sobre la que se apoya todo. */
export const WATER = {
  base: '#2d81bd',
  shade: '#1d5f92',
  deep: '#123f63',
  foam: 'rgba(226,244,255,0.5)',
};

export const TABLE = {
  base: '#75492a',
  light: '#94643c',
  dark: '#33200f',
  grain: 'rgba(48,27,10,0.32)',
};

/** Mezcla dos colores #rrggbb. `t` = 0 devuelve `a`, `t` = 1 devuelve `b`. */
export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round((((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t));
  const g = Math.round((((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t));
  const bl = Math.round(((pa & 255) * (1 - t) + (pb & 255) * t));
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/** Oscurece un color hacia negro. */
export function shade(color: string, amount: number): string {
  return mix(color, '#000000', amount);
}

/** Aclara un color hacia blanco. */
export function tint(color: string, amount: number): string {
  return mix(color, '#ffffff', amount);
}
