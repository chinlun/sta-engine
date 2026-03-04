import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export const uploadToR2 = async (key: string, body: Buffer | string, contentType: string) => {
    const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
    const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "sta-themes";

    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
        throw new Error("Missing Cloudflare R2 credentials in .env");
    }

    const s3Client = new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });

    console.log(`[R2] Uploading ${key} to bucket ${R2_BUCKET_NAME}`);
    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            Body: body,
            ContentType: contentType,
        }));

        const publicUrl = process.env.R2_PUBLIC_URL;
        if (!publicUrl) {
            throw new Error("Missing R2_PUBLIC_URL in .env");
        }
        return `${publicUrl}/${key}`;
    } catch (error) {
        console.error("Error uploading to R2:", error);
        throw error;
    }
};
