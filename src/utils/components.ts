import { OpenAPIV3 } from 'openapi-types';
import { z } from 'zod';

import { zodSchemaToOpenApiSchemaObject } from '../generator/schema';
import { OpenApiProcedureRecord, OpenApiRouter } from '../types';
import { forEachOpenApiProcedure, getInputOutputParsers } from './procedure';
import { instanceofZodType, instanceofZodTypeLikeVoid, instanceofZodTypeObject, unwrapZodType } from './zod';
import { TRPCError } from '@trpc/server';
import { getPathParameters, normalizePath } from './path';

export let zodComponentSchemaGenerator: (() => { [key: string]: any }) | undefined;

export let zodComponentDefinitions: Record<string, z.ZodType> | undefined;

export const setZodComponentDefinitions = (definitions: Record<string, z.ZodType>) => {
  zodComponentDefinitions = definitions;
};

export const setZodComponentSchemaGenerator = (generator: typeof zodComponentSchemaGenerator) => {
  zodComponentSchemaGenerator = generator;
};

// Does not support references (breaks in weird ways if references are used)
export const experimentalZodSchemaGenerator = (): { [key: string]: OpenAPIV3.SchemaObject } => {
  return zodComponentDefinitions
    ? Object.fromEntries(
      Object.entries(zodComponentDefinitions).map(([key, value]) => [
        key,
        zodSchemaToOpenApiSchemaObject(value, true),
      ]),
    )
    : {};
};

interface ComponentRelationships {
  [key: string]: Record<string, any>; // Or whatever structure suits your data
}
const generateComponentRelationships = (schema: any, name: string) => {
  const componentRelationships: ComponentRelationships = {};

  const processSchema = (currentSchema: any, prefix = name || '') => {
    for (const key in currentSchema.shape) {
      const prop = currentSchema.shape[key];
      const fullPath = prefix ? `${prefix}.${key}` : key;

      if (prop instanceof z.ZodOptional && prop._def.innerType instanceof z.ZodObject) {
        if (!componentRelationships[fullPath]) {
          componentRelationships[fullPath] = {};
        }

        processSchema(prop._def.innerType, fullPath);
      } else if (prop instanceof z.ZodOptional && prop._def.innerType instanceof z.ZodArray && prop._def.innerType._def.type instanceof z.ZodObject) {
        const arrayTypeName = prop._def.innerType._def.type._def.typeName;
        const arrayComponentKey = `${key}`;

        if (!componentRelationships[prefix]) {
          componentRelationships[prefix] = {};
        }

        componentRelationships[prefix][key] = {
          type: 'zodArray',
          component: arrayComponentKey,
          optional: true,
        };

        if (!componentRelationships[fullPath]) {
          componentRelationships[fullPath] = {};
        }

        processSchema(prop._def.innerType._def.type, fullPath);
      } else if (prop instanceof z.ZodObject || (prop instanceof z.ZodArray && prop._def.type instanceof z.ZodObject)) {

        const typeName = prop instanceof z.ZodObject ? prop._def.typeName : prop._def.type._def.typeName;

        if (!componentRelationships[prefix]) {
          componentRelationships[prefix] = {};
        }

        const componentKey = fullPath.substring(fullPath.lastIndexOf('.') + 1);

        componentRelationships[prefix][key] = {
          type: typeName,
          optional: prop instanceof z.ZodOptional || currentSchema.shape[key] instanceof z.ZodOptional,
          component: componentKey,
        };
        if (prop instanceof z.ZodArray)
          processSchema(prop._def.type, fullPath)
        else
          processSchema(prop, fullPath);
      } else {
        const typeName = prop._def.typeName;

        if (!componentRelationships[prefix]) {
          componentRelationships[prefix] = {};
        }

        componentRelationships[prefix][key] = {
          type: prop instanceof z.ZodOptional ? prop._def.innerType._def.typeName : typeName.toString(),
          optional: prop instanceof z.ZodOptional ? true : false,
        };
      }
    }
  };

  processSchema(schema);

  const finalRelationships = {};
  for (const key in componentRelationships) {
    const parts = key.split('.');
    const componentName = parts[parts.length - 1];
    finalRelationships[componentName] = componentRelationships[key];
  }

  return finalRelationships;
};


export function extractAllComponents(schemasAndNames: Record<string, any>): Record<string, any> {
  let mergedMap: Record<string, any> = new Map();

  for (const [key, value] of Object.entries(schemasAndNames)) {
    const result: Record<string, any> = generateComponentRelationships(value, key);
    for (const [mapKey, mapValue] of result.entries()) {
      mergedMap.set(mapKey, mapValue);
    }
  }

  return mergedMap;
}


export function extractSchemas(appRouter: OpenApiRouter) {
  const pathsObject: OpenAPIV3.PathsObject = {};
  const procedures = appRouter._def.procedures as OpenApiProcedureRecord;

  const schemasAndIds: Record<string, any> = {}

  forEachOpenApiProcedure(procedures, ({ path: procedurePath, type, procedure, openapi }) => {
    const id = procedurePath.replace(/\./g, '-').toString()
    const path = normalizePath(openapi.path);
    const pathParameters = getPathParameters(path);
    const { inputParser, outputParser } = getInputOutputParsers(procedure);
    const inputBody = getInputZodObject(inputParser, pathParameters)

    schemasAndIds.set(id, inputBody)
  })

  const components = extractAllComponents(schemasAndIds)

  return components
}


function getInputZodObject(schema: unknown, pathParameters: string[],) {
  if (!instanceofZodType(schema)) {
    throw new TRPCError({
      message: 'Input parser expects a Zod validator',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }

  const unwrappedSchema = unwrapZodType(schema, true);

  if (pathParameters.length === 0 && instanceofZodTypeLikeVoid(unwrappedSchema)) {
    return undefined;
  }

  if (!instanceofZodTypeObject(unwrappedSchema)) {
    throw new TRPCError({
      message: 'Input parser must be a ZodObject',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }

  return unwrappedSchema;
}