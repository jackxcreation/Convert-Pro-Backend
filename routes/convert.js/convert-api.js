# File Conversion API for Convert Pro

```javascript
// app/api/convert/route.js

import { NextRequest, NextResponse } from 'next/server';
import { convertFile, cleanupTempFiles } from '@/lib/converters';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { isConversionSupported } from '@/middleware/fileValidation';
import path from 'path';
import fs from 'fs/promises';

/**
 * POST /api/convert
 * Convert uploaded file to target format
 */
export async function POST(request) {
  try {
    // Parse request body
    const { fileId, targetFormat, options = {} } = await request.json();
    
    if (!fileId || !targetFormat) {
      return NextResponse.json(
        { error: 'fileId and targetFormat are required' },
        { status: 400 }
      );
    }
    
    // Get user authentication
    const supabase = createClientComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    
    // Fetch file metadata from database
    const { data: fileMetadata, error: fetchError } = await supabase
      .from('file_uploads')
      .select('*')
      .eq('id', fileId)
      .single();
      
    if (fetchError || !fileMetadata) {
      return NextResponse.json(
        { error: 'File not found or access denied' },
        { status: 404 }
      );
    }
    
    // Verify user has access to this file
    if (fileMetadata.user_id && fileMetadata.user_id !== user?.id) {
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      );
    }
    
    // Check if conversion is supported
    const inputFormat = path.extname(fileMetadata.original_name).slice(1).toLowerCase();
    if (!isConversionSupported(inputFormat, targetFormat)) {
      return NextResponse.json(
        { error: `Conversion from ${inputFormat} to ${targetFormat} is not supported` },
        { status: 400 }
      );
    }
    
    // Check if file still exists
    try {
      await fs.access(fileMetadata.temp_path);
    } catch {
      return NextResponse.json(
        { error: 'Source file no longer available. Please upload again.' },
        { status: 410 }
      );
    }
    
    // Update status to 'converting'
    await supabase
      .from('file_uploads')
      .update({ 
        status: 'converting',
        conversion_started_at: new Date().toISOString()
      })
      .eq('id', fileId);
    
    // Start conversion with progress tracking
    const conversionId = `conversion_${fileId}`;
    
    try {
      const result = await convertFile(
        fileMetadata.temp_path,
        targetFormat,
        {
          quality: options.quality || 90,
          width: options.width,
          height: options.height,
          resize: options.resize || 'fit',
          ...options
        },
        (progress, message) => {
          // Store progress in database for real-time updates
          updateConversionProgress(supabase, fileId, progress, message);
        }
      );
      
      // Get file size of converted file
      const stats = await fs.stat(result.outputPath);
      const outputSize = stats.size;
      
      // Update database with successful conversion
      const { data: conversionRecord } = await supabase
        .from('file_uploads')
        .update({
          status: 'completed',
          output_path: result.outputPath,
          output_filename: result.outputFileName,
          output_format: targetFormat,
          output_size: outputSize,
          conversion_completed_at: new Date().toISOString(),
          conversion_options: options
        })
        .eq('id', fileId)
        .select()
        .single();
      
      // Generate secure download URL (expires in 24 hours)
      const downloadToken = await generateDownloadToken(fileId, result.outputPath);
      
      return NextResponse.json({
        success: true,
        conversionId: fileId,
        downloadUrl: `/api/download/${downloadToken}`,
        fileInfo: {
          originalName: fileMetadata.original_name,
          originalSize: fileMetadata.size,
          outputFormat: targetFormat,
          outputSize: outputSize,
          outputSizeFormatted: formatFileSize(outputSize),
          compressionRatio: ((fileMetadata.size - outputSize) / fileMetadata.size * 100).toFixed(1)
        },
        message: 'File converted successfully'
      });
      
    } catch (conversionError) {
      console.error('Conversion failed:', conversionError);
      
      // Update status to failed
      await supabase
        .from('file_uploads')
        .update({ 
          status: 'failed',
          error_message: conversionError.message,
          conversion_completed_at: new Date().toISOString()
        })
        .eq('id', fileId);
      
      return NextResponse.json(
        { error: `Conversion failed: ${conversionError.message}` },
        { status: 500 }
      );
    }
    
  } catch (error) {
    console.error('Conversion API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/convert/progress/:fileId
 * Get real-time conversion progress
 */
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const fileId = url.pathname.split('/').pop();
    
    if (!fileId) {
      return NextResponse.json(
        { error: 'File ID required' },
        { status: 400 }
      );
    }
    
    const supabase = createClientComponentClient();
    
    // Get conversion progress from database
    const { data: fileData, error } = await supabase
      .from('file_uploads')
      .select('status, conversion_progress, conversion_message, error_message')
      .eq('id', fileId)
      .single();
      
    if (error || !fileData) {
      return NextResponse.json(
        { error: 'Conversion not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      fileId,
      status: fileData.status,
      progress: fileData.conversion_progress || 0,
      message: fileData.conversion_message || 'Preparing...',
      error: fileData.error_message
    });
    
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to get progress' },
      { status: 500 }
    );
  }
}

/**
 * Helper Functions
 */

// Update conversion progress in database
async function updateConversionProgress(supabase, fileId, progress, message) {
  try {
    await supabase
      .from('file_uploads')
      .update({
        conversion_progress: progress,
        conversion_message: message,
        updated_at: new Date().toISOString()
      })
      .eq('id', fileId);
  } catch (error) {
    console.error('Failed to update progress:', error);
  }
}

// Generate secure download token
async function generateDownloadToken(fileId, outputPath) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  
  const supabase = createClientComponentClient();
  
  // Store download token with expiry
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours from now
  
  await supabase
    .from('download_tokens')
    .insert([{
      token,
      file_id: fileId,
      file_path: outputPath,
      expires_at: expiresAt.toISOString(),
      created_at: new Date().toISOString()
    }]);
  
  return token;
}

// Format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Background cleanup job (call periodically)
 */
export async function runCleanup() {
  try {
    // Clean up old temporary files
    await cleanupTempFiles();
    
    // Clean up expired download tokens
    const supabase = createClientComponentClient();
    
    const { data: expiredTokens } = await supabase
      .from('download_tokens')
      .select('file_path')
      .lt('expires_at', new Date().toISOString());
      
    // Delete expired files
    if (expiredTokens) {
      for (const token of expiredTokens) {
        try {
          await fs.unlink(token.file_path);
        } catch (error) {
          console.error('Failed to delete expired file:', error);
        }
      }
      
      // Remove expired tokens from database
      await supabase
        .from('download_tokens')
        .delete()
        .lt('expires_at', new Date().toISOString());
    }
    
    console.log('Cleanup completed successfully');
  } catch (error) {
    console.error('Cleanup failed:', error);
  }
}
```

## Additional Database Tables:

```sql
-- Download tokens table
CREATE TABLE download_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  file_id UUID REFERENCES file_uploads(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  downloads INTEGER DEFAULT 0,
  max_downloads INTEGER DEFAULT 5,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add conversion tracking columns to file_uploads
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS conversion_started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS conversion_completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS conversion_progress INTEGER DEFAULT 0;
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS conversion_message TEXT;
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS output_path TEXT;
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS output_filename TEXT;
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS output_format TEXT;
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS output_size BIGINT;
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS conversion_options JSONB;
ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Indexes
CREATE INDEX idx_download_tokens_token ON download_tokens(token);
CREATE INDEX idx_download_tokens_expires ON download_tokens(expires_at);
CREATE INDEX idx_file_uploads_status ON file_uploads(status);
```

## Frontend Usage Example:

```javascript
// Convert file with progress tracking
async function convertFile(fileId, targetFormat, options = {}) {
  try {
    // Start conversion
    const response = await fetch('/api/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileId,
        targetFormat,
        options
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error);
    }
    
    const result = await response.json();
    console.log('Conversion completed:', result);
    
    return result;
  } catch (error) {
    console.error('Conversion failed:', error);
    throw error;
  }
}

// Track conversion progress
async function trackProgress(fileId, onProgress) {
  const pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`/api/convert/progress/${fileId}`);
      const progress = await response.json();
      
      onProgress(progress);
      
      if (progress.status === 'completed' || progress.status === 'failed') {
        clearInterval(pollInterval);
      }
    } catch (error) {
      console.error('Progress tracking failed:', error);
      clearInterval(pollInterval);
    }
  }, 1000);
  
  return pollInterval;
}
```

This conversion API provides:
- âœ… **Real-time progress tracking** (Database-backed progress updates)
- âœ… **Secure file handling** (Access control and validation)
- âœ… **Error management** (Comprehensive error handling and recovery)
- âœ… **Download tokens** (Secure, expiring download links)
- âœ… **Cleanup system** (Automatic cleanup of temporary files)
- âœ… **Conversion options** (Quality, size, and format parameters)
- âœ… **Status tracking** (Complete conversion lifecycle management)
