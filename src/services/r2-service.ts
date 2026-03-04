import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function createR2Client(): S3Client {
    const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
    const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
        throw new Error("Missing Cloudflare R2 credentials in .env");
    }

    return new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        forcePathStyle: true,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });
}

/**
 * Uploads a file to R2 and returns a signed URL (60s expiry) for Shopify ingestion.
 * Per SPEC §4.3: "The R2 Handshake Protocol" — signed URL ensures the bucket stays private.
 */
export const uploadToR2 = async (key: string, body: Buffer | string, contentType: string): Promise<string> => {
    const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "sta-themes";
    const s3Client = createR2Client();

    console.log(`[R2] Uploading ${key} to bucket ${R2_BUCKET_NAME}`);

    try {
        // Step 1: Upload the object
        await s3Client.send(new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            Body: body,
            ContentType: contentType,
        }));

        // Step 2: Generate a signed GET URL (60s expiry) for Shopify to fetch
        const signedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: key,
            }),
            { expiresIn: 60 }
        );

        console.log(`[R2] Signed URL generated (60s expiry)`);
        return signedUrl;
    } catch (error) {
        console.error("Error uploading to R2:", error);
        throw error;
    }
};
