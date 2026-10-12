import { describe, expect, it } from 'vitest';
import { imageModelConfigFromMetadata } from './probe-openrouter-image-config.mjs';

describe('image catalog configuration', () => {
 it('uses current values instead of stale model-family guesses', () => {
  expect(imageModelConfigFromMetadata({id:'microsoft/mai-image-2.6', supportedParameters:{
   aspect_ratio:{type:'enum',values:['1:1','auto']},
  }}, {aspectRatios:['1:1','21:9'],imageSizes:['1K','4K']})).toEqual({aspectRatios:['1:1','auto'],imageSizes:[]});
 });
 it('includes new resolution tiers without unsupported pixel sizes', () => {
  expect(imageModelConfigFromMetadata({supportedParameters:{
   resolution:{type:'enum',values:['768','1K','1.5K','4K']},
   aspect_ratio:{type:'enum',values:['7:5','1:1']},
  }}, {aspectRatios:[],imageSizes:['1K','1024x1024']})).toEqual({aspectRatios:['7:5','1:1'],imageSizes:['768','1K','1.5K','4K']});
 });
 it('preserves observed arbitrary sizes when the catalog permits them', () => {
  expect(imageModelConfigFromMetadata({supportedParameters:{size:{type:'boolean'}}},
   {aspectRatios:['16:9'],imageSizes:['1K','1024x1536']})).toEqual({aspectRatios:[],imageSizes:['1024x1536']});
 });
 it('keeps unsupported parameters empty and seeds one arbitrary-size probe', () => {
  expect(imageModelConfigFromMetadata({supportedParameters:{}})).toEqual({aspectRatios:[],imageSizes:[]});
  expect(imageModelConfigFromMetadata({supportedParameters:{size:{type:'boolean'}}})).toEqual({aspectRatios:[],imageSizes:['1024x1024']});
 });
});
