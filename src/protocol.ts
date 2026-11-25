export interface Source {
  id: string;
  name: string;
  path?: string;
  text: string;
}

export type TargetPlatform = 'asic' | 'fpga';

export type SynthesisStage = 'synthesis' | 'netlist' | 'sta' | 'place-route' | 'bitstream';

export interface BuildOptions {
  standard: '1364-2005' | '1800-2017' | '1800-2023';
  top: string;
  mode: 'rtl' | 'gate';
  hierarchy: boolean;
  optimize: boolean;
  abc: boolean;
  observe: boolean;
  includes: string[];
  defines: string[];
  parameters: string[];
  extraCommands?: string[];
}

export type Bit = number | '0' | '1' | 'x' | 'z';
export type Direction = 'input' | 'output' | 'inout';
export interface Port {
  direction: Direction;
  bits: Bit[];
  offset?: number;
  upto?: number;
  signed?: number;
}
export interface Net {
  bits: Bit[];
  hide_name?: number;
  attributes?: Record<string, string>;
  offset?: number;
  upto?: number;
  signed?: number;
}
export interface Cell {
  type: string;
  parameters: Record<string, string>;
  connections: Record<string, Bit[]>;
  port_directions: Record<string, Direction>;
}
export interface Module {
  attributes?: Record<string, string>;
  ports: Record<string, Port>;
  netnames: Record<string, Net>;
  cells: Record<string, Cell>;
}
export interface Netlist {
  modules: Record<string, Module>;
}
export interface Diagnostic {
  id: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}
export type FpgaClockTiming = Record<string, { achieved: number; constraint: number }>;

export interface BuildResult {
  fpgaTiming?: FpgaClockTiming;
  timingReport?: string;
  bitstream?: Uint8Array;
  ok: boolean;
  log: string;
  diagnostics: Diagnostic[];
  netlist?: Netlist;
  sourceNetlist?: Netlist;
  top?: string;
}
