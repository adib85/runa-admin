/**
 * S3 Service
 * Handles image uploads (primarily for DyFashion)
 */

import AWS from "aws-sdk";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";
import { S3_CONFIG } from "./config.js";

class S3Service {
  constructor() {
    this.s3 = new AWS.S3({
      accessKeyId: S3_CONFIG.accessKeyId,
      secretAccessKey: S3_CONFIG.secretAccessKey,
      region: S3_CONFIG.region
    });
    this.bucket = S3_CONFIG.bucket;
    this.keyPrefix = S3_CONFIG.keyPrefix;
  }

  async uploadImageFromUrl(imageUrl) {
    if (!imageUrl) return null;
    
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        console.log(`Failed to fetch image: ${response.status}`);
        return null;
      }
      
      const buffer = await response.buffer();
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const extension = contentType.split('/')[1] || 'jpg';
      const key = `${this.keyPrefix}${uuidv4()}.${extension}`;

      const uploadParams = {
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read'
      };

      const result = await this.s3.upload(uploadParams).promise();
      console.log(`Image uploaded successfully: ${result.Location}`);
      return result.Location;
    } catch (error) {
      console.error('Error uploading image to S3:', error);
      return null;
    }
  }

  async uploadMultipleImages(imageUrls) {
    if (!imageUrls || imageUrls.length === 0) return [];
    
    const results = await Promise.all(
      imageUrls.map(url => this.uploadImageFromUrl(url))
    );
    
    return results.filter(url => url !== null);
  }
}

export default new S3Service();
