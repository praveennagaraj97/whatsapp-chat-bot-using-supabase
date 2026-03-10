FROM denoland/deno:1.46.3

WORKDIR /app

COPY deno.json ./
COPY supabase ./supabase

RUN deno cache supabase/functions/webhook/index.ts

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "supabase/functions/webhook/index.ts"]
