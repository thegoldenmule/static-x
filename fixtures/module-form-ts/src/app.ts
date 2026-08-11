import greet from './greet.js';
import * as tone from './tone.js';

export const line = greet('world') + tone.shout('hey') + String(tone.LOUD);
