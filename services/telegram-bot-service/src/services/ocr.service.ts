import { createWorker, Worker } from 'tesseract.js';
import sharp from 'sharp';
import * as fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';

export class OCRService {
  private worker: Worker | null = null;

  async initialize(): Promise<void> {
    try {
      this.worker = await createWorker('rus+eng');
      logger.info('OCR worker initialized');
    } catch (error) {
      logger.error('Failed to initialize OCR worker:', error);
      throw error;
    }
  }

  async processImage(imagePath: string): Promise<string> {
    if (!this.worker) {
      await this.initialize();
    }

    try {
      // Preprocess image for better OCR results
      const processedImagePath = await this.preprocessImage(imagePath);

      // Perform OCR
      const { data: { text } } = await this.worker!.recognize(processedImagePath);

      // Clean up processed image
      await fs.unlink(processedImagePath);

      logger.info(`OCR completed for ${imagePath}, extracted ${text.length} characters`);
      return text;
    } catch (error) {
      logger.error('OCR processing failed:', error);
      throw error;
    }
  }

  private async preprocessImage(imagePath: string): Promise<string> {
    const processedPath = imagePath.replace(path.extname(imagePath), '_processed.jpg');

    await sharp(imagePath)
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .normalize()
      .sharpen()
      .toFile(processedPath);

    return processedPath;
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      logger.info('OCR worker terminated');
    }
  }
}

export const ocrService = new OCRService();
