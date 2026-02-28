import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import config from "@runa/config";

/**
 * S3 storage service for images and files
 */

let s3Client = null;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: config.s3.region,
      credentials: config.aws.accessKeyId
        ? {
            accessKeyId: config.aws.accessKeyId,
            secretAccessKey: config.aws.secretAccessKey
          }
        : undefined
    });
  }
  return s3Client;
}

/**
 * Upload an image from URL to S3
 * @param {string} imageUrl - Source image URL
 * @param {Object} options - { folder, filename }
 * @returns {Promise<string|null>} - S3 URL or null on failure
 */
export async function uploadImageFromUrl(imageUrl, options = {}) {
  const { folder = "", filename } = options;

  try {
    // Fetch image from URL
    const response = await fetch(imageUrl);
    if (!response.ok) {
      console.error(`Failed to fetch image: ${response.statusText}`);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "image/jpeg";

    // Extract file extension
    const urlParts = imageUrl.split(".");
    const extension = urlParts[urlParts.length - 1].split("?")[0] || "jpg";

    // Generate S3 key
    const key = `${config.s3.keyPrefix}${folder ? folder + "/" : ""}${filename || uuidv4()}.${extension}`;

    // Upload to S3
    const client = getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: Buffer.from(buffer),
        ContentType: contentType,
        ACL: "public-read"
      })
    );

    const s3Url = `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${key}`;
    console.log(`Image uploaded: ${s3Url}`);
    return s3Url;
  } catch (error) {
    console.error("Error uploading image to S3:", error);
    return null;
  }
}

/**
 * Upload a buffer to S3
 * @param {Buffer} buffer - File buffer
 * @param {string} key - S3 key (path)
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} - S3 URL
 */
export async function uploadBuffer(buffer, key, contentType = "application/octet-stream") {
  const client = getS3Client();

  const fullKey = `${config.s3.keyPrefix}${key}`;

  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: fullKey,
      Body: buffer,
      ContentType: contentType,
      ACL: "public-read"
    })
  );

  return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${fullKey}`;
}

/**
 * Upload JSON data to S3
 * @param {Object} data - JSON data
 * @param {string} key - S3 key (path)
 * @returns {Promise<string>} - S3 URL
 */
export async function uploadJson(data, key) {
  const buffer = Buffer.from(JSON.stringify(data, null, 2));
  return uploadBuffer(buffer, key, "application/json");
}

/**
 * Get object from S3
 * @param {string} key - S3 key
 * @returns {Promise<Buffer|null>} - File buffer or null
 */
export async function getObject(key) {
  try {
    const client = getS3Client();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: key
      })
    );

    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    console.error("Error getting object from S3:", error);
    return null;
  }
}

/**
 * Delete object from S3
 * @param {string} key - S3 key
 */
export async function deleteObject(key) {
  try {
    const client = getS3Client();
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.s3.bucket,
        Key: key
      })
    );
  } catch (error) {
    console.error("Error deleting object from S3:", error);
  }
}

/**
 * Upload multiple product images
 * @param {Array<string>} imageUrls - Array of image URLs
 * @param {string} productId - Product ID for folder organization
 * @returns {Promise<Array<string>>} - Array of S3 URLs
 */
export async function uploadProductImages(imageUrls, productId) {
  const results = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const s3Url = await uploadImageFromUrl(url, {
      folder: `products/${productId}`,
      filename: `image_${i}`
    });
    if (s3Url) {
      results.push(s3Url);
    }
  }

  return results;
}

export default {
  uploadImageFromUrl,
  uploadBuffer,
  uploadJson,
  getObject,
  deleteObject,
  uploadProductImages
};
