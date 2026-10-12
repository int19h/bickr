import { describe, expect, it } from 'vitest';
import { imageModelConfigFromMetadata, imageSizeProbeCandidates } from './probe-openrouter-image-config.mjs';

describe('image catalog configuration', () => {
 it('uses current ratios while preserving prior size shorthand observations', () => {
  expect(imageModelConfigFromMetadata({id:'microsoft/mai-image-2.6', supportedParameters:{
   aspect_ratio:{type:'enum',values:['1:1','auto']},
  }}, {aspectRatios:['1:1','21:9'],imageSizes:['1K','4K']})).toEqual({aspectRatios:['1:1','auto'],imageSizes:['1K','4K']});
 });
 it('includes new resolution tiers and preserves successful size shorthands', () => {
  expect(imageModelConfigFromMetadata({supportedParameters:{
   resolution:{type:'enum',values:['768','1K','1.5K','4K']},
   aspect_ratio:{type:'enum',values:['7:5','1:1']},
  }}, {aspectRatios:[],imageSizes:['1K','1024x1024']})).toEqual({aspectRatios:['7:5','1:1'],imageSizes:['768','1K','1.5K','4K','1024x1024']});
 });
 it('preserves successful dimensions when direct size metadata is absent', () => {
  expect(imageModelConfigFromMetadata({supportedParameters:{aspect_ratio:{type:'enum',values:['1:1']}}},
   {aspectRatios:['1:1'],imageSizes:['1024x1024']})).toEqual({aspectRatios:['1:1'],imageSizes:['1024x1024']});
 });
 it('preserves observed arbitrary sizes when the catalog permits them', () => {
  expect(imageModelConfigFromMetadata({supportedParameters:{size:{type:'boolean'}}},
   {aspectRatios:['16:9'],imageSizes:['1K','1024x1536']})).toEqual({aspectRatios:[],imageSizes:['1K','1024x1536']});
 });
 it('publishes no arbitrary-size guess in metadata mode', () => {
  expect(imageModelConfigFromMetadata({supportedParameters:{}})).toEqual({aspectRatios:[],imageSizes:[]});
  expect(imageModelConfigFromMetadata({supportedParameters:{size:{type:'boolean'}}})).toEqual({aspectRatios:[],imageSizes:[]});
 });
 it('probes arbitrary sizes for both new and empty existing rows without publishing them', () => {
  const model={supportedParameters:{size:{type:'boolean'}}};
  for(const existing of [undefined,{aspectRatios:[],imageSizes:[]}]) {
   const config=imageModelConfigFromMetadata(model,existing);
   expect(imageSizeProbeCandidates(model,config)).toEqual(['1024x1024']);
   expect(config.imageSizes).toEqual([]);
  }
 });
});
