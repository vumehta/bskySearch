import { GET } from '../../api/search.mjs';

export async function onRequestGet(context) {
  return GET(context.request, { env: context.env });
}
