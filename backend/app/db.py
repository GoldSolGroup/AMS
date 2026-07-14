from prisma import Prisma

prisma = Prisma()


async def connect():
    if not prisma.is_connected():
        await prisma.connect()


async def disconnect():
    if prisma.is_connected():
        await prisma.disconnect()
